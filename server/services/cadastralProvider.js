/**
 * cadastralProvider.js — Provider catastali lato server.
 *
 *  CadastralProvider (interfaccia)
 *    ├─ AgenziaEntrateMapProvider   → cartografia pubblica AdE (WMS/WFS), nessun dato personale
 *  OwnershipProvider (interfaccia intestatari)
 *    ├─ NoneOwnershipProvider       → "Visura catastale non configurata" (default)
 *    ├─ MockOwnershipProvider       → SOLO sviluppo, dati fittizi dichiarati
 *    └─ ExternalHttpOwnershipProvider → adattatore verso un servizio AUTORIZZATO (configurato dall'ente)
 *
 * NOTA: non esiste un'API pubblica dell'Agenzia delle Entrate per gli intestatari. SISTER e i servizi di
 * interoperabilità richiedono convenzione/abilitazione: questo modulo NON effettua scraping né aggira
 * autenticazioni; espone solo un punto di integrazione verso un servizio che l'utilizzatore è autorizzato a usare.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../middleware/log.js';
import * as core from '../../js/catasto-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class NotConfiguredError extends Error {
  constructor(msg = 'Visura catastale non configurata.') { super(msg); this.code = 'NOT_CONFIGURED'; this.status = 501; }
}
class UpstreamError extends Error {
  constructor(msg, code = 'UPSTREAM') { super(msg); this.code = code; this.status = 502; }
}
class NotFoundError extends Error {
  constructor(msg) { super(msg); this.code = 'NOT_FOUND'; this.status = 404; }
}

async function fetchText(url, timeoutMs = 30000) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': config.userAgent, Accept: '*/*' } });
  } catch (err) {
    throw new UpstreamError(err.name === 'TimeoutError' ? 'Il servizio cartografico non risponde (timeout).' : 'Servizio cartografico temporaneamente non disponibile.', 'UPSTREAM_TIMEOUT');
  }
  if (!res.ok) throw new UpstreamError(`Servizio cartografico non disponibile (${res.status}).`);
  return res.text();
}

/* ------------------------------------------------------------------ */
export class CadastralProvider {
  async identifyPoint() { throw new Error('Non implementato'); }
  async findParcel() { throw new Error('Non implementato'); }
  async getParcelGeometry() { throw new Error('Non implementato'); }
  async getParcelInfo() { throw new Error('Non implementato'); }
  async getOwnershipInfo() { throw new NotConfiguredError(); }
}

/* ------------------------------------------------------------------ */
export class AgenziaEntrateMapProvider extends CadastralProvider {
  constructor() {
    super();
    this.wms = config.catastoWmsUrl;
    this.wfs = config.catastoWfsUrl;
    this.comuni = null;
    this.fogli = new Map();
    this.boundaries = new Map();
    this.lastNominatim = 0;
  }

  loadComuni() {
    if (this.comuni) return this.comuni;
    const file = path.resolve(__dirname, '..', '..', 'data', 'comuni.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.comuni = { byCode: new Map(), list: j.comuni.map((r) => ({ nome: r[0], codice: r[1], sigla: r[2], provincia: r[3], regione: r[4], key: core.normalizeName(r[0]) })) };
    for (const c of this.comuni.list) this.comuni.byCode.set(c.codice, c);
    return this.comuni;
  }

  describe(ref, feature) {
    const p = core.parseReference(ref);
    if (!p) return null;
    const c = this.loadComuni().byCode.get(p.codiceComune);
    return {
      ref: p.ref, codiceComune: p.codiceComune, comune: c ? c.nome : null, provincia: c ? c.provincia : null, sigla: c ? c.sigla : null,
      sezione: p.sezione, foglio: p.foglio, foglioLabel: p.foglioLabel, allegato: p.allegato, sviluppo: p.sviluppo, particella: p.particella,
      geometry: feature ? feature.geometry : null, bbox: feature ? feature.bbox : null,
      areaGeometrica: feature ? Math.round(core.geodesicArea(feature.geometry)) : null
    };
  }

  async identifyPoint(lat, lon, { geometry = true } = {}) {
    if (geometry) {
      try {
        const feats = core.parseWfsGml(await fetchText(core.buildWfsBboxUrl(this.wfs, core.AE_WFS_TYPES.parcel, core.bboxAround(lon, lat, 0.00025), { count: 40 }), 40000));
        const hit = feats.find((f) => core.polygonContains(f.geometry, lon, lat));
        if (hit) return this.describe(hit.properties.ref, hit);
      } catch (err) { log.warn('WFS identify fallito, uso GetFeatureInfo:', err.message); }
    }
    const info = core.parseGetFeatureInfoHtml(await fetchText(core.buildGetFeatureInfoUrl(this.wms, lon, lat)));
    return info.parcels[0] ? this.describe(info.parcels[0].ref, null) : null;
  }

  async comuneBoundary(c) {
    if (this.boundaries.has(c.codice)) return this.boundaries.get(c.codice);
    const wait = 1100 - (Date.now() - this.lastNominatim);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastNominatim = Date.now();
    const u = `${config.geocoderUrl}/search?${new URLSearchParams({ q: `${c.nome}, ${c.sigla}, Italia`, format: 'jsonv2', countrycodes: 'it', limit: '5' })}`;
    const json = JSON.parse(await fetchText(u, 20000));
    const hit = json.find((r) => r.category === 'boundary' && r.type === 'administrative') || json[0];
    if (!hit) throw new NotFoundError(`Territorio del Comune di ${c.nome} non trovato.`);
    const b = { bbox: [+hit.boundingbox[2], +hit.boundingbox[0], +hit.boundingbox[3], +hit.boundingbox[1]] };
    this.boundaries.set(c.codice, b);
    return b;
  }

  async findParcel(codiceComune, foglio, particella, { sezione = '' } = {}) {
    const c = this.loadComuni().byCode.get(String(codiceComune).toUpperCase());
    if (!c) throw new NotFoundError('Codice catastale del Comune non riconosciuto.');
    if (!this.fogli.has(c.codice)) {
      const b = await this.comuneBoundary(c);
      const [minX, minY, maxX, maxY] = b.bbox;
      const feats = core.parseWfsGml(await fetchText(core.buildWfsBboxUrl(this.wfs, core.AE_WFS_TYPES.zoning, [minX - 0.01, minY - 0.01, maxX + 0.01, maxY + 0.01]), 90000));
      const m = new Map();
      for (const z of feats) if (z.properties.ref && z.properties.ref.startsWith(c.codice)) m.set(z.properties.ref, z.bbox);
      this.fogli.set(c.codice, m);
    }
    const fogli = this.fogli.get(c.codice);
    const wanted = core.buildFoglioRef({ codiceComune: c.codice, sezione, foglio });
    let foglioRef = fogli.has(wanted) ? wanted : [...fogli.keys()].find((k) => k.startsWith(wanted.slice(0, -2)));
    if (!foglioRef) throw new NotFoundError(`Foglio ${foglio} non trovato nel Comune di ${c.nome}.`);
    const target = `${foglioRef}.${core.normalizeParticella(particella)}`;
    const feats = core.parseWfsGml(await fetchText(core.buildWfsBboxUrl(this.wfs, core.AE_WFS_TYPES.parcel, fogli.get(foglioRef)), 120000));
    const hit = feats.find((f) => f.properties.ref === target);
    if (!hit) throw new NotFoundError(`Particella ${particella} non trovata nel foglio ${foglio} di ${c.nome}.`);
    return this.describe(hit.properties.ref, hit);
  }

  async getParcelGeometry(ref, { lon, lat }) {
    const feats = core.parseWfsGml(await fetchText(core.buildWfsBboxUrl(this.wfs, core.AE_WFS_TYPES.parcel, core.bboxAround(lon, lat, 0.0004))));
    const hit = feats.find((f) => f.properties.ref === ref);
    if (!hit) throw new NotFoundError('Geometria non disponibile.');
    return hit;
  }

  async getParcelInfo(parcel) {
    return { superficieGeometrica: parcel.areaGeometrica, note: 'Il servizio cartografico pubblico non espone dati censuari.' };
  }
}

/* ------------------------------------------------------------------ */
/* Intestatari                                                          */
/* ------------------------------------------------------------------ */
export class OwnershipProvider {
  constructor() { this.name = 'none'; this.configured = false; this.note = ''; }
  /** @returns {Promise<{fonte, dataVisura, immobile, intestatari:[{nome,cognome,titolarita,quota}], demo?}>} */
  async getOwnershipInfo() { throw new NotConfiguredError(); }
}

export class NoneOwnershipProvider extends OwnershipProvider {
  constructor() { super(); this.note = 'Nessun servizio autorizzato collegato: impostare OWNERSHIP_PROVIDER in .env'; }
}

export class MockOwnershipProvider extends OwnershipProvider {
  constructor() { super(); this.name = 'mock'; this.configured = true; this.note = 'DATI FITTIZI — solo sviluppo'; }
  async getOwnershipInfo(q) {
    await new Promise((r) => setTimeout(r, 400));
    return {
      demo: true, fonte: 'MOCK — DATI FITTIZI DI SVILUPPO', dataVisura: new Date().toISOString().slice(0, 10),
      immobile: { codiceComune: q.codiceComune, sezione: q.sezione || null, foglio: q.foglio, particella: q.particella, subalterno: q.subalterno || null, tipo: 'Terreno (fittizio)' },
      intestatari: [
        { nome: 'MARIO', cognome: 'ROSSI (DATO FITTIZIO)', titolarita: 'Proprietà', quota: '1/2' },
        { nome: 'ANNA', cognome: 'BIANCHI (DATO FITTIZIO)', titolarita: 'Proprietà', quota: '1/2' }
      ]
    };
  }
}

/**
 * Adattatore HTTP generico verso un servizio autorizzato (contratto JSON documentato nel README):
 *   GET {OWNERSHIP_API_URL}?codiceComune=&sezione=&foglio=&particella=&subalterno=
 *   Authorization: Bearer {OWNERSHIP_API_TOKEN}
 *   → { fonte, dataVisura, immobile:{}, intestatari:[{nome,cognome,titolarita,quota}] }
 */
export class ExternalHttpOwnershipProvider extends OwnershipProvider {
  constructor() {
    super();
    this.name = 'http';
    this.configured = !!(config.ownershipApiUrl && config.ownershipApiToken);
    this.note = this.configured ? `Servizio autorizzato: ${new URL(config.ownershipApiUrl).host}` : 'OWNERSHIP_API_URL/OWNERSHIP_API_TOKEN mancanti';
  }
  async getOwnershipInfo(q) {
    if (!this.configured) throw new NotConfiguredError();
    const u = new URL(config.ownershipApiUrl);
    for (const k of ['codiceComune', 'sezione', 'foglio', 'particella', 'subalterno']) if (q[k]) u.searchParams.set(k, q[k]);
    let res;
    try {
      res = await fetch(u, { signal: AbortSignal.timeout(config.ownershipApiTimeout), headers: { Authorization: `Bearer ${config.ownershipApiToken}`, Accept: 'application/json', 'User-Agent': config.userAgent } });
    } catch (err) { throw new UpstreamError('Servizio visure non raggiungibile.', 'OWNERSHIP_UPSTREAM'); }
    if (res.status === 404) throw new NotFoundError('Immobile non trovato nel servizio visure.');
    if (!res.ok) throw new UpstreamError(`Servizio visure: errore ${res.status}.`, 'OWNERSHIP_UPSTREAM');
    const j = await res.json();
    if (!j || !Array.isArray(j.intestatari)) throw new UpstreamError('Risposta del servizio visure non conforme al contratto.', 'OWNERSHIP_SCHEMA');
    return {
      fonte: String(j.fonte || 'servizio autorizzato'), dataVisura: String(j.dataVisura || ''), immobile: j.immobile || {},
      intestatari: j.intestatari.map((i) => ({ nome: String(i.nome || ''), cognome: String(i.cognome || ''), titolarita: String(i.titolarita || ''), quota: String(i.quota || '') }))
    };
  }
}

export function createOwnershipProvider() {
  switch (config.ownershipProvider) {
    case 'mock': return config.isDev ? new MockOwnershipProvider() : new NoneOwnershipProvider();
    case 'http': return new ExternalHttpOwnershipProvider();
    default: return new NoneOwnershipProvider();
  }
}
