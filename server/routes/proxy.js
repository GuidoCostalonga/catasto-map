/**
 * proxy.js — Proxy controllato verso i servizi OGC (WMS/WFS).
 *
 * Perché serve: il WMS/WFS dell'Agenzia delle Entrate non invia header CORS e il WMS del
 * Geoportale Nazionale risponde solo in http. Il proxy:
 *  - accetta solo richieste OGC note (whitelist di REQUEST e parametri);
 *  - limita dimensioni immagine e area BBOX;
 *  - mette in cache le risposte (GetMap, GetFeature, GetCapabilities) per ridurre il carico sui servizi ufficiali;
 *  - non inoltra cookie né intestazioni del client.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { log } from '../middleware/log.js';

const router = Router();

const SERVICES = {
  catasto: { wms: config.catastoWmsUrl, wfs: config.catastoWfsUrl },
  ...(config.pcnWmsUrl ? { pcn: { wms: config.pcnWmsUrl } } : {}),
  ...Object.fromEntries(Object.entries(config.extraWmsProxies).map(([id, url]) => [id.toLowerCase(), { wms: url }]))
};
export const proxyIds = Object.fromEntries(Object.entries(SERVICES).map(([id, s]) => [id, Object.keys(s)]));

const WMS_REQUESTS = new Set(['GETCAPABILITIES', 'GETMAP', 'GETFEATUREINFO', 'GETLEGENDGRAPHIC']);
const WFS_REQUESTS = new Set(['GETCAPABILITIES', 'DESCRIBEFEATURETYPE', 'GETFEATURE']);
const WMS_PARAMS = new Set(['SERVICE', 'VERSION', 'REQUEST', 'LAYERS', 'QUERY_LAYERS', 'STYLES', 'CRS', 'SRS', 'BBOX', 'WIDTH', 'HEIGHT', 'FORMAT', 'TRANSPARENT', 'I', 'J', 'X', 'Y', 'INFO_FORMAT', 'FEATURE_COUNT', 'LAYER', 'SLD_VERSION', 'STYLE', 'BGCOLOR', 'EXCEPTIONS', 'TILED', 'MAP_RESOLUTION', 'DPI', 'LANGUAGE', 'MAP']);
const WFS_PARAMS = new Set(['SERVICE', 'VERSION', 'REQUEST', 'TYPENAMES', 'TYPENAME', 'BBOX', 'COUNT', 'STARTINDEX', 'SRSNAME', 'OUTPUTFORMAT', 'MAXFEATURES']);
const MAX_BBOX_DEG2 = 0.6; // ~ 55 km × 45 km: copre qualsiasi Comune italiano (Roma ≈ 0.12)

/* ---------------- cache LRU in memoria ---------------- */
class LruCache {
  constructor(maxEntries = 600, maxBytes = 200 * 1024 * 1024) { this.map = new Map(); this.max = maxEntries; this.maxBytes = maxBytes; this.bytes = 0; }
  get(k) {
    const e = this.map.get(k);
    if (!e) return null;
    if (e.exp < Date.now()) { this.delete(k); return null; }
    this.map.delete(k); this.map.set(k, e);
    return e;
  }
  set(k, e) {
    if (this.map.has(k)) this.delete(k);
    this.map.set(k, e); this.bytes += e.body.length;
    while (this.map.size > this.max || this.bytes > this.maxBytes) this.delete(this.map.keys().next().value);
  }
  delete(k) { const e = this.map.get(k); if (e) { this.bytes -= e.body.length; this.map.delete(k); } }
}
const cache = new LruCache();
const inflight = new Map();

function ttlFor(service, request) {
  if (request === 'GETCAPABILITIES' || request === 'DESCRIBEFEATURETYPE' || request === 'GETLEGENDGRAPHIC') return 6 * 3600 * 1000;
  if (request === 'GETMAP') return 20 * 60 * 1000;
  if (request === 'GETFEATURE') return 30 * 60 * 1000;
  if (request === 'GETFEATUREINFO') return 10 * 60 * 1000;
  return 60 * 1000;
}

function buildUpstream(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/* ---------------- limitatore di concorrenza per host upstream ----------------
 * I server MapServer dell'AdE rispondono 500 sporadicamente quando ricevono troppe richieste
 * simultanee: si limita il numero di connessioni contemporanee per host e si ritenta una volta. */
const MAX_CONCURRENT_PER_HOST = 4;
const hostQueues = new Map();
function withHostSlot(host, fn) {
  const q = hostQueues.get(host) || { active: 0, waiting: [] };
  hostQueues.set(host, q);
  return new Promise((resolve, reject) => {
    const run = () => {
      q.active++;
      fn().then(resolve, reject).finally(() => { q.active--; const next = q.waiting.shift(); if (next) next(); });
    };
    if (q.active < MAX_CONCURRENT_PER_HOST) run(); else q.waiting.push(run);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': config.userAgent, Accept: '*/*' }, redirect: 'follow' });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') || 'application/octet-stream', body };
}

async function fetchUpstream(url, timeoutMs, retries = 2) {
  const host = new URL(url).host;
  return withHostSlot(host, async () => {
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await sleep(250 * attempt + Math.random() * 250);
      try {
        last = await fetchOnce(url, timeoutMs);
        if (last.status < 500) return last;
      } catch (err) {
        if (attempt === retries || err.name === 'TimeoutError') throw err;
        last = null;
      }
    }
    return last;
  });
}

async function handle(req, res, next, service) {
  try {
    const id = String(req.params.id || '').toLowerCase();
    const target = SERVICES[id] && SERVICES[id][service];
    if (!target) return res.status(404).json({ code: 'UNKNOWN_PROXY', message: `Proxy ${service}/${id} non configurato.` });
    // normalizza parametri (case-insensitive) e applica whitelist
    const allowed = service === 'wms' ? WMS_PARAMS : WFS_PARAMS;
    const params = {};
    for (const [k, v] of Object.entries(req.query)) {
      const K = k.toUpperCase();
      if (!allowed.has(K) || typeof v !== 'string' || v.length > 2000) continue;
      params[K] = v;
    }
    const request = String(params.REQUEST || '').toUpperCase();
    const ok = service === 'wms' ? WMS_REQUESTS.has(request) : WFS_REQUESTS.has(request);
    if (!ok) return res.status(400).json({ code: 'BAD_REQUEST', message: 'Richiesta OGC non consentita.' });
    params.SERVICE = service.toUpperCase();
    if (service === 'wms') {
      const w = Number(params.WIDTH || 0), h = Number(params.HEIGHT || 0);
      if (w > 2048 || h > 2048) return res.status(400).json({ code: 'BAD_REQUEST', message: 'Dimensione immagine eccessiva.' });
    }
    if (service === 'wfs' && request === 'GETFEATURE') {
      const b = String(params.BBOX || '').split(',').map(Number);
      if (b.length < 4 || b.some((n) => !Number.isFinite(n))) return res.status(400).json({ code: 'BAD_REQUEST', message: 'GetFeature richiede un BBOX valido.' });
      const area = Math.abs(b[2] - b[0]) * Math.abs(b[3] - b[1]);
      if (area > MAX_BBOX_DEG2) return res.status(400).json({ code: 'BBOX_TOO_LARGE', message: 'Area richiesta troppo estesa.' });
    }
    const upstream = buildUpstream(target, params);
    const key = upstream;
    const hit = cache.get(key);
    if (hit) {
      res.setHeader('X-Proxy-Cache', 'HIT');
      return send(res, hit, request);
    }
    let p = inflight.get(key);
    if (!p) {
      const timeout = service === 'wfs' ? 120000 : 40000;
      p = fetchUpstream(upstream, timeout).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const r = await p;
    if (r.status >= 200 && r.status < 300 && !/ServiceException/i.test(r.body.subarray(0, 400).toString())) {
      cache.set(key, { ...r, exp: Date.now() + ttlFor(service, request) });
    }
    res.setHeader('X-Proxy-Cache', 'MISS');
    send(res, r, request);
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    log.warn(`proxy ${service}/${req.params.id} ${timeout ? 'timeout' : 'errore'}: ${err.message}`);
    res.status(timeout ? 504 : 502).json({ code: timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR', message: 'Servizio cartografico temporaneamente non disponibile.' });
  }
}

function send(res, r, request) {
  res.status(r.status);
  res.setHeader('Content-Type', r.type);
  res.setHeader('Cache-Control', request === 'GETMAP' || request === 'GETLEGENDGRAPHIC' ? 'public, max-age=1200' : 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(r.body);
}

router.get('/wms/:id', (req, res, next) => handle(req, res, next, 'wms'));
router.get('/wfs/:id', (req, res, next) => handle(req, res, next, 'wfs'));
router.get('/status', (req, res) => res.json({ proxies: proxyIds, cache: { entries: cache.map.size, bytes: cache.bytes } }));

export default router;
