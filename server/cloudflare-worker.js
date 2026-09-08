/**
 * cloudflare-worker.js — Proxy OGC minimale per pubblicare il frontend su hosting statico
 * (GitHub Pages, Netlify, Cloudflare Pages) senza il server Node.
 *
 * Espone:  https://<worker>.workers.dev/wms/catasto  e  /wfs/catasto
 * Config frontend (js/config.js):
 *   CATASTO_WMS_URL: 'https://<worker>.workers.dev/wms/catasto'
 *   CATASTO_WFS_URL: 'https://<worker>.workers.dev/wfs/catasto'
 *
 * Deploy:  npx wrangler deploy server/cloudflare-worker.js --name catasto-map-proxy
 * Variabile facoltativa ALLOWED_ORIGINS: "https://utente.github.io,https://catasto.example.org"
 *
 * NOTA: qui passano SOLO dati cartografici pubblici (CC BY 4.0). Le visure restano sul backend autenticato.
 */
const SERVICES = {
  catasto: {
    wms: 'https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php',
    wfs: 'https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php'
  },
  pcn: { wms: 'http://wms.pcn.minambiente.it/ogc?map=/ms_ogc/WMS_v1.3/raster/ortofoto_colore_12.map' }
};
const WMS_REQUESTS = ['GETCAPABILITIES', 'GETMAP', 'GETFEATUREINFO', 'GETLEGENDGRAPHIC'];
const WFS_REQUESTS = ['GETCAPABILITIES', 'DESCRIBEFEATURETYPE', 'GETFEATURE'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : 'null'),
      'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const m = url.pathname.match(/^\/(wms|wfs)\/([a-z0-9_-]+)\/?$/i);
    if (!m) return new Response('Not found', { status: 404, headers: cors });
    const service = m[1].toLowerCase(), id = m[2].toLowerCase();
    const target = SERVICES[id] && SERVICES[id][service];
    if (!target) return new Response('Unknown proxy', { status: 404, headers: cors });

    const req = (url.searchParams.get('REQUEST') || url.searchParams.get('request') || '').toUpperCase();
    if (!(service === 'wms' ? WMS_REQUESTS : WFS_REQUESTS).includes(req)) return new Response('OGC request not allowed', { status: 400, headers: cors });
    if (service === 'wfs' && req === 'GETFEATURE') {
      const b = (url.searchParams.get('BBOX') || '').split(',').map(Number);
      if (b.length < 4 || b.some((n) => !Number.isFinite(n)) || Math.abs(b[2] - b[0]) * Math.abs(b[3] - b[1]) > 0.6) return new Response('BBOX missing or too large', { status: 400, headers: cors });
    }
    const upstream = new URL(target);
    url.searchParams.forEach((v, k) => upstream.searchParams.set(k, v));

    const cache = caches.default;
    const cacheKey = new Request(upstream.toString(), { method: 'GET' });
    let res = await cache.match(cacheKey);
    if (!res) {
      const up = await fetch(upstream.toString(), { headers: { 'User-Agent': 'CatastoMap-Worker/1.0' }, cf: { cacheTtl: 0 } });
      const body = await up.arrayBuffer();
      const ttl = req === 'GETMAP' ? 1200 : req === 'GETFEATURE' ? 1800 : 600;
      res = new Response(body, { status: up.status, headers: { 'Content-Type': up.headers.get('Content-Type') || 'application/octet-stream', 'Cache-Control': `public, max-age=${ttl}` } });
      if (up.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  }
};
