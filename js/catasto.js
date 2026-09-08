/**
 * catasto.js — Provider catastali lato browser.
 *
 * Architettura a provider: l'applicazione parla solo con l'interfaccia CadastralProvider;
 * AgenziaEntrateMapProvider la implementa sui servizi OGC pubblici dell'Agenzia delle Entrate.
 *
 * LIMITI TECNICI VERIFICATI (settembre 2026) sui servizi ufficiali:
 *  - WMS: GetFeatureInfo restituisce foglio/particella (NationalCadastralReference) solo con
 *    INFO_FORMAT=text/html; con text/plain e GML torna solo il boundedBy. Nessun attributo censuario
 *    (superficie, qualità, classe, redditi): il servizio è puramente cartografico.
 *  - WFS: GetFeature accetta esclusivamente TYPENAMES + BBOX (+COUNT/STARTINDEX). I filtri FES
 *    per attributo ("PropertyIsEqualTo" su NATIONALCADASTRALREFERENCE) sono rifiutati con
 *    "Richiesta non valida". La ricerca inversa Comune/foglio/particella è quindi realizzata in due passi:
 *    1) BBOX del Comune (da OSM/Nominatim) → CP:CadastralZoning → bbox del foglio;
 *    2) BBOX del foglio → CP:CadastralParcel → filtro client-side sul riferimento.
 *  - Nessun header CORS: le chiamate passano dal proxy configurato in config.js.
 */
import * as core from './catasto-core.js';

const CONFIG = window.CATASTO_CONFIG;

export class CatastoError extends Error {
  constructor(message, code = 'GENERIC', cause) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

/* ------------------------------------------------------------------ */
/* Indice dei Comuni (ISTAT + codice catastale)                          */
/* ------------------------------------------------------------------ */
export class ComuniIndex {
  constructor(url) {
    this.url = url;
    this.list = [];
    this.byCode = new Map();
    this.ready = this.load();
  }

  async load() {
    const res = await fetch(this.url);
    if (!res.ok) throw new Error('Impossibile caricare l\'elenco dei Comuni');
    const json = await res.json();
    this.list = json.comuni.map((r) => ({ nome: r[0], codice: r[1], sigla: r[2], provincia: r[3], regione: r[4], istat: r[5], key: core.normalizeName(r[0]) }));
    for (const c of this.list) this.byCode.set(c.codice, c);
    this.list.sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
    return this.list.length;
  }

  byCodice(code) { return this.byCode.get(String(code || '').toUpperCase()) || null; }

  nameOf(code) { const c = this.byCodice(code); return c ? c.nome : code; }

  /** Trova un Comune per nome (accenti/maiuscole ignorati). Se ambiguo usa la sigla provincia. */
  find(nome, sigla) {
    if (!nome) return null;
    const n = String(nome).trim();
    if (/^[A-Z]\d{3}$/i.test(n)) return this.byCodice(n);
    const key = core.normalizeName(n);
    let hits = this.list.filter((c) => c.key === key);
    if (!hits.length) { const flat = key.replace(/ /g, ''); hits = this.list.filter((c) => c.key.replace(/ /g, '') === flat); } // "RoveredoInPiano"
    if (!hits.length) hits = this.list.filter((c) => c.key.startsWith(key));
    if (!hits.length) hits = this.list.filter((c) => key.startsWith(c.key) && c.key.length >= 4);
    if (sigla) {
      const s = String(sigla).toUpperCase();
      const bySigla = hits.filter((c) => c.sigla === s);
      if (bySigla.length) hits = bySigla;
    }
    if (hits.length > 1) hits.sort((a, b) => Math.abs(a.key.length - key.length) - Math.abs(b.key.length - key.length));
    return hits[0] || null;
  }

  search(prefix, limit = 8, filter = {}) {
    const key = core.normalizeName(prefix);
    if (!key) return [];
    const out = [];
    for (const c of this.list) {
      if (filter.sigla && c.sigla !== filter.sigla) continue;
      if (filter.regione && c.regione !== filter.regione) continue;
      if (c.key.startsWith(key)) { out.push(c); if (out.length >= limit) break; }
    }
    if (out.length < limit) {
      for (const c of this.list) {
        if (out.includes(c)) continue;
        if (filter.sigla && c.sigla !== filter.sigla) continue;
        if (filter.regione && c.regione !== filter.regione) continue;
        if (c.key.includes(key)) { out.push(c); if (out.length >= limit) break; }
      }
    }
    return out;
  }

  regioni() { return [...new Set(this.list.map((c) => c.regione))].sort((a, b) => a.localeCompare(b, 'it')); }
  province(regione) {
    const m = new Map();
    for (const c of this.list) if (!regione || c.regione === regione) m.set(c.sigla, c.provincia);
    return [...m.entries()].map(([sigla, nome]) => ({ sigla, nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  }
  comuni(sigla) { return this.list.filter((c) => c.sigla === sigla); }
}

/* ------------------------------------------------------------------ */
/* Interfaccia provider                                                  */
/* ------------------------------------------------------------------ */
export class CadastralProvider {
  /** Identifica la particella in un punto (lat/lon WGS84). */
  async identifyPoint(lat, lon, opts) { throw new CatastoError('Non implementato', 'NOT_IMPLEMENTED'); }
  /** Trova una particella da Comune/foglio/particella. */
  async findParcel(comune, foglio, particella, opts) { throw new CatastoError('Non implementato', 'NOT_IMPLEMENTED'); }
  /** Geometria (GeoJSON) di una particella. */
  async getParcelGeometry(ref, hint, opts) { throw new CatastoError('Non implementato', 'NOT_IMPLEMENTED'); }
  /** Informazioni descrittive disponibili. */
  async getParcelInfo(parcel) { throw new CatastoError('Non implementato', 'NOT_IMPLEMENTED'); }
  /** Intestatari: solo tramite backend autorizzato. */
  async getOwnershipInfo(parcel, opts) { throw new CatastoError('Non implementato', 'NOT_IMPLEMENTED'); }
  async checkServices() { return {}; }
}

/* ------------------------------------------------------------------ */
/* Provider Agenzia delle Entrate (WMS/WFS pubblici)                     */
/* ------------------------------------------------------------------ */
export class AgenziaEntrateMapProvider extends CadastralProvider {
  constructor({ wmsUrl, wfsUrl, comuni, geocoder, api, cacheMax = 4000 }) {
    super();
    this.wmsUrl = wmsUrl;
    this.wfsUrl = wfsUrl;
    this.comuni = comuni;
    this.geocoder = geocoder;
    this.api = api;
    this.cacheMax = cacheMax;
    this.mode = CONFIG.IDENTIFY_MODE || 'auto';
    this.capabilities = { wms: null, wfs: null, gfi: null, layers: [] };
    this.featureCache = new Map();   // ref -> feature GeoJSON-like (con bbox)
    this.fogliIndex = new Map();     // codiceComune -> Map(foglioRef -> {bbox,label})
    this.parcelIndex = new Map();    // foglioRef -> Map(ref -> bbox)
    this.stats = { requests: 0, cacheHits: 0 };
  }

  get useWfs() {
    if (this.mode === 'wms') return false;
    if (this.mode === 'wfs') return true;
    return this.capabilities.wfs !== false;
  }

  /* ---------- rete ---------- */
  async fetchText(url, { signal, timeout = CONFIG.REQUEST_TIMEOUT_MS || 25000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    this.stats.requests++;
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'text/html, text/xml, application/xml, */*' } });
      if (res.status === 429) throw new CatastoError('Troppe richieste: attendere qualche secondo.', 'RATE_LIMIT');
      if (!res.ok) throw new CatastoError('Servizio cartografico temporaneamente non disponibile.', 'HTTP_' + res.status);
      return await res.text();
    } catch (err) {
      if (err instanceof CatastoError) throw err;
      if (err.name === 'AbortError') {
        if (signal && signal.aborted) throw new CatastoError('Richiesta annullata', 'ABORTED');
        throw new CatastoError('Il servizio cartografico non risponde (timeout).', 'TIMEOUT', err);
      }
      throw new CatastoError('Servizio cartografico temporaneamente non disponibile.', 'NETWORK', err);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async gfi(lon, lat, signal) {
    const html = await this.fetchText(core.buildGetFeatureInfoUrl(this.wmsUrl, lon, lat), { signal });
    return core.parseGetFeatureInfoHtml(html);
  }

  async wfsBbox(typeName, bbox, { signal, count, timeout } = {}) {
    const xml = await this.fetchText(core.buildWfsBboxUrl(this.wfsUrl, typeName, bbox, { count }), { signal, timeout });
    try {
      return core.parseWfsGml(xml);
    } catch (err) {
      throw new CatastoError('Il servizio WFS ha rifiutato la richiesta.', 'WFS_EXCEPTION', err);
    }
  }

  /* ---------- cache geometrie ---------- */
  addToCache(features) {
    for (const f of features) {
      if (!f.properties.ref) continue;
      if (this.featureCache.size >= this.cacheMax) {
        // svuota la metà più vecchia (Map mantiene l'ordine di inserimento)
        let n = Math.floor(this.cacheMax / 2);
        for (const k of this.featureCache.keys()) { this.featureCache.delete(k); if (--n <= 0) break; }
      }
      this.featureCache.set(f.properties.ref, f);
    }
  }

  cachedAt(lon, lat) {
    for (const f of this.featureCache.values()) {
      const b = f.bbox;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (core.polygonContains(f.geometry, lon, lat)) return f;
    }
    return null;
  }

  cachedByRef(ref) { return this.featureCache.get(ref) || null; }

  /* ---------- risultato normalizzato ---------- */
  describe(ref, feature, extra = {}) {
    const p = core.parseReference(ref);
    if (!p) return null;
    const comune = this.comuni.byCodice(p.codiceComune);
    const geometry = feature ? feature.geometry : null;
    return {
      ref: p.ref, codiceComune: p.codiceComune, comune: comune ? comune.nome : p.codiceComune,
      provincia: comune ? comune.provincia : '', sigla: comune ? comune.sigla : '', regione: comune ? comune.regione : '',
      sezione: p.sezione, foglio: p.foglio, foglioLabel: p.foglioLabel, allegato: p.allegato, sviluppo: p.sviluppo,
      particella: p.particella, foglioRef: p.foglioRef,
      geometry, bbox: feature ? feature.bbox : null,
      areaGeometrica: geometry ? Math.round(core.geodesicArea(geometry)) : null,
      ...extra
    };
  }

  /* ---------- identificazione puntuale ---------- */
  /**
   * @param {number} lat
   * @param {number} lon
   * @param {{signal?:AbortSignal, mode?:'hover'|'click', allowNetwork?:boolean}} opts
   * @returns {Promise<object|null>} particella descritta (con geometria se disponibile) oppure null
   */
  async identifyPoint(lat, lon, opts = {}) {
    const cached = this.cachedAt(lon, lat);
    if (cached) {
      this.stats.cacheHits++;
      return this.describe(cached.properties.ref, cached, { source: 'cache' });
    }
    if (opts.allowNetwork === false) return null;

    /*
     * Strategia (verificata sul campo): il GetFeatureInfo WMS risponde in ~0,3 s e fornisce subito
     * foglio/particella; il WFS fornisce la geometria ma a tratti impiega decine di secondi.
     * Le due richieste partono in parallelo: si risponde con la prima utile, la geometria arriva
     * tramite `geometryPromise` (e alimenta la cache per gli hover successivi).
     */
    const useGfi = this.mode !== 'wfs' && this.capabilities.gfi !== false;
    const useWfs = this.useWfs;
    const half = CONFIG.HOVER.halfDeg || 0.00025;
    let wfsError = null;
    const wfsP = useWfs
      ? this.wfsBbox(core.AE_WFS_TYPES.parcel, core.bboxAround(lon, lat, half), { signal: opts.signal, count: 60, timeout: 60000 })
        .then((feats) => { this.addToCache(feats); this.capabilities.wfs = true; return feats; })
        .catch((err) => {
          wfsError = err;
          if (err.code !== 'ABORTED' && err.code !== 'TIMEOUT' && err.code !== 'RATE_LIMIT') this.capabilities.wfs = false;
          return null;
        })
      : Promise.resolve(null);

    let info = null;
    if (useGfi) {
      try {
        info = await this.gfi(lon, lat, opts.signal);
        this.capabilities.gfi = true;
      } catch (err) {
        if (err.code === 'ABORTED' || !useWfs) throw err;
        info = null; // si prosegue con il solo WFS
      }
    }
    if (info && info.parcels[0]) {
      const ref = info.parcels[0].ref;
      const cached = this.cachedByRef(ref);
      const result = this.describe(ref, cached, { source: 'wms', zoning: info.zonings[0] || null });
      if (!cached && useWfs) {
        result.geometryPromise = wfsP.then((feats) => (feats && (feats.find((f) => f.properties.ref === ref) || feats.find((f) => core.polygonContains(f.geometry, lon, lat)))) || null);
      }
      return result;
    }
    // GFI senza particella (o non disponibile): si attende il WFS
    const feats = await wfsP;
    if (feats) {
      const hit = feats.find((f) => core.polygonContains(f.geometry, lon, lat));
      if (hit) return this.describe(hit.properties.ref, hit, { source: 'wfs' });
    } else if (!info && wfsError) {
      throw wfsError;
    }
    if (info && info.zonings[0]) {
      const z = info.zonings[0];
      return { onlyFoglio: true, ...this.describe(z.foglioRef + '.0', null), particella: null, foglioLabel: z.label, source: 'wms' };
    }
    return null;
  }

  /** Geometria della particella: dalla cache o via WFS attorno a un punto/bbox suggerito. */
  async getParcelGeometry(ref, hint = {}, opts = {}) {
    const c = this.cachedByRef(ref);
    if (c) return c;
    if (!this.useWfs) throw new CatastoError('La geometria vettoriale non è disponibile con il solo WMS.', 'NO_GEOMETRY');
    let bbox = hint.bbox;
    if (!bbox && hint.lon !== undefined) bbox = core.bboxAround(hint.lon, hint.lat, 0.0004);
    if (!bbox) throw new CatastoError('Posizione della particella sconosciuta.', 'NO_HINT');
    const feats = await this.wfsBbox(core.AE_WFS_TYPES.parcel, bbox, { signal: opts.signal });
    this.addToCache(feats);
    const hit = feats.find((f) => f.properties.ref === ref);
    if (!hit) throw new CatastoError('Geometria della particella non restituita dal WFS.', 'NOT_FOUND');
    return hit;
  }

  /* ---------- ricerca inversa ---------- */
  resolveComune(comune, sigla) {
    const c = typeof comune === 'object' && comune ? comune : this.comuni.find(comune, sigla);
    if (!c) throw new CatastoError(`Comune "${comune}" non trovato nell'elenco ISTAT.`, 'COMUNE_NOT_FOUND');
    return c;
  }

  /** Indice dei fogli di un Comune: foglioRef -> {bbox, label}. Costoso la prima volta (WFS CadastralZoning sul bbox comunale). */
  async getFogliIndex(comune, { signal, progress } = {}) {
    const c = this.resolveComune(comune);
    if (this.fogliIndex.has(c.codice)) return this.fogliIndex.get(c.codice);
    const lsKey = `cm:fogli:${c.codice}`;
    try {
      const saved = JSON.parse(localStorage.getItem(lsKey) || 'null');
      if (saved && saved.v === 1 && Date.now() - saved.t < 30 * 86400000) {
        const m = new Map(Object.entries(saved.d));
        m.boundary = saved.b || null;
        this.fogliIndex.set(c.codice, m);
        return m;
      }
    } catch (_) { /* ignora */ }

    progress && progress(`Ricerca del territorio di ${c.nome}…`);
    const boundary = await this.geocoder.comuneBoundary(c.nome, c.sigla, signal);
    if (!boundary || !boundary.bbox) throw new CatastoError(`Confine del Comune di ${c.nome} non disponibile dal geocoder.`, 'BOUNDARY_NOT_FOUND');
    const [minX, minY, maxX, maxY] = boundary.bbox;
    const padX = (maxX - minX) * 0.03, padY = (maxY - minY) * 0.03;
    progress && progress(`Interrogazione WFS dei fogli di mappa di ${c.nome}…`);
    const zonings = await this.wfsBbox(core.AE_WFS_TYPES.zoning, [minX - padX, minY - padY, maxX + padX, maxY + padY], { signal, timeout: 90000 });
    const m = new Map();
    for (const z of zonings) {
      const ref = z.properties.ref;
      if (!ref || !ref.startsWith(c.codice)) continue;
      m.set(ref, { bbox: z.bbox, label: z.properties.LABEL || '' });
    }
    if (!m.size) throw new CatastoError(`Nessun foglio catastale trovato per ${c.nome} nel bbox del Comune.`, 'NO_FOGLI');
    m.boundary = { bbox: boundary.bbox, lon: boundary.lon, lat: boundary.lat };
    this.fogliIndex.set(c.codice, m);
    try { localStorage.setItem(lsKey, JSON.stringify({ v: 1, t: Date.now(), d: Object.fromEntries(m), b: m.boundary })); } catch (_) { /* quota */ }
    return m;
  }

  /**
   * findParcel: Comune (nome o codice o oggetto), foglio ("12", "12A", "12_B"), particella ("428", "12/3").
   * Ritorna la particella descritta con geometria e bbox.
   */
  async findParcel(comune, foglio, particella, opts = {}) {
    const { signal, progress, sezione = '', sigla } = opts;
    if (!this.useWfs) throw new CatastoError('La ricerca per foglio e particella richiede il servizio WFS, non disponibile.', 'WFS_UNAVAILABLE');
    const c = this.resolveComune(comune, sigla);
    if (!foglio) throw new CatastoError('Indicare il foglio.', 'VALIDATION');
    if (!particella) throw new CatastoError('Indicare la particella.', 'VALIDATION');
    const fogli = await this.getFogliIndex(c, { signal, progress });
    const wantedRef = core.buildFoglioRef({ codiceComune: c.codice, sezione, foglio });
    let foglioRef = fogli.has(wantedRef) ? wantedRef : null;
    if (!foglioRef) {
      const base = wantedRef.slice(0, -2);
      const candidates = [...fogli.keys()].filter((k) => k.startsWith(base));
      if (candidates.length === 1) foglioRef = candidates[0];
      else if (candidates.length > 1) foglioRef = candidates.find((k) => k.endsWith('00')) || candidates[0];
    }
    if (!foglioRef) {
      const disponibili = [...fogli.values()].map((v) => v.label).filter(Boolean).slice(0, 40).join(', ');
      throw new CatastoError(`Foglio ${foglio} non trovato nel Comune di ${c.nome}${sezione ? ' sez. ' + sezione : ''}. Fogli disponibili: ${disponibili}…`, 'FOGLIO_NOT_FOUND');
    }
    const foglioInfo = fogli.get(foglioRef);
    const target = `${foglioRef}.${core.normalizeParticella(particella)}`;

    // 1) particella già in cache o in indice del foglio
    let feature = this.cachedByRef(target);
    if (!feature && this.parcelIndex.has(foglioRef)) {
      const bbox = this.parcelIndex.get(foglioRef).get(target);
      if (bbox) {
        progress && progress('Recupero geometria della particella…');
        const feats = await this.wfsBbox(core.AE_WFS_TYPES.parcel, bbox, { signal });
        this.addToCache(feats);
        feature = feats.find((f) => f.properties.ref === target) || null;
      }
    }
    // 2) scarica tutte le particelle del foglio (unica modalità possibile: il WFS non filtra per attributo)
    if (!feature) {
      progress && progress(`Scaricamento delle particelle del foglio ${foglioInfo.label || foglio} (può richiedere alcuni secondi)…`);
      const feats = await this.wfsBbox(core.AE_WFS_TYPES.parcel, foglioInfo.bbox, { signal, timeout: 120000 });
      const idx = new Map();
      for (const f of feats) if (f.properties.ref && f.properties.ref.startsWith(foglioRef + '.')) idx.set(f.properties.ref, f.bbox);
      this.parcelIndex.set(foglioRef, idx);
      this.addToCache(feats.filter((f) => f.properties.ref && f.properties.ref.startsWith(foglioRef + '.')));
      feature = feats.find((f) => f.properties.ref === target) || null;
      if (!feature) {
        // tentativo: particella con zeri iniziali o variante di case
        const alt = [...idx.keys()].find((k) => core.normalizeParticella(k.split('.').pop()) === core.normalizeParticella(particella));
        if (alt) feature = feats.find((f) => f.properties.ref === alt);
      }
      if (!feature) throw new CatastoError(`Particella ${particella} non trovata nel foglio ${foglioInfo.label || foglio} di ${c.nome} (${idx.size} particelle nel foglio).`, 'PARTICELLA_NOT_FOUND');
    }
    return this.describe(feature.properties.ref, feature, { source: 'wfs', foglioBbox: foglioInfo.bbox, comuneBoundary: fogli.boundary || null });
  }

  /** Dati descrittivi: il servizio pubblico è solo cartografico, i dati censuari non sono esposti. */
  async getParcelInfo(parcel) {
    return {
      superficieGeometrica: parcel.areaGeometrica,
      superficieCatastale: null, qualita: null, classe: null, redditoDominicale: null, redditoAgrario: null,
      note: 'Superficie calcolata dalla geometria WFS (indicativa). Qualità, classe e redditi non sono esposti dai servizi cartografici pubblici: richiedono la visura.'
    };
  }

  /** Intestatari: esclusivamente tramite backend autenticato (vedi server/). */
  async getOwnershipInfo(parcel, { motivo, subalterno } = {}) {
    if (!this.api) throw new CatastoError('Visura catastale non configurata.', 'NOT_CONFIGURED');
    return this.api.visura({ codiceComune: parcel.codiceComune, sezione: parcel.sezione, foglio: parcel.foglio, particella: parcel.particella, subalterno, motivo });
  }

  /* ---------- verifica servizi ---------- */
  async checkServices() {
    const out = { wms: { ok: false }, wfs: { ok: false }, gfi: { ok: false } };
    try {
      const xml = await this.fetchText(core.buildCapabilitiesUrl(this.wmsUrl, 'WMS'), { timeout: 20000 });
      const names = [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]).filter((n) => n !== 'WMS' && n !== 'default');
      const gfiFormats = [...(xml.match(/<GetFeatureInfo>[\s\S]*?<\/GetFeatureInfo>/) || [''])[0].matchAll(/<Format>([^<]+)<\/Format>/g)].map((m) => m[1]);
      const crs = [...new Set([...xml.matchAll(/<CRS>([^<]+)<\/CRS>/g)].map((m) => m[1]))];
      const required = Object.values(core.AE_WMS_LAYERS);
      out.wms = { ok: names.length > 0, layers: names, missing: required.filter((r) => !names.includes(r)), gfiFormats, crs, title: (xml.match(/<Title>([^<]+)<\/Title>/) || [])[1] };
      this.capabilities.wms = out.wms.ok;
      this.capabilities.layers = names;
    } catch (err) { out.wms = { ok: false, error: err.message }; this.capabilities.wms = false; }
    try {
      const xml = await this.fetchText(core.buildCapabilitiesUrl(this.wfsUrl, 'WFS'), { timeout: 20000 });
      const types = [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]);
      out.wfs = { ok: types.includes(core.AE_WFS_TYPES.parcel), types };
      this.capabilities.wfs = out.wfs.ok;
    } catch (err) { out.wfs = { ok: false, error: err.message }; this.capabilities.wfs = false; }
    try {
      // punto di test: Porcia (PN), particella verificata G886_001400.2317 (dato pubblico)
      const info = await this.gfi(12.6215, 45.9505);
      out.gfi = { ok: info.parcels.length > 0 || info.zonings.length > 0, sample: info.parcels[0] ? info.parcels[0].ref : null };
      this.capabilities.gfi = out.gfi.ok ? true : null;
    } catch (err) { out.gfi = { ok: false, error: err.message }; this.capabilities.gfi = null; /* non si esclude: il servizio può essere solo lento */ }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Provider "mock" per intestatari: SOLO sviluppo, dati chiaramente fittizi */
/* ------------------------------------------------------------------ */
export class MockOwnershipProvider extends CadastralProvider {
  async getOwnershipInfo(parcel) {
    await new Promise((r) => setTimeout(r, 500));
    return {
      status: 'ok', demo: true, fonte: 'MOCK — DATI FITTIZI DI SVILUPPO', dataVisura: new Date().toISOString().slice(0, 10),
      immobile: { comune: parcel.comune, foglio: parcel.foglio, particella: parcel.particella, tipo: 'Terreno (fittizio)', superficie: parcel.areaGeometrica },
      intestatari: [
        { nome: 'MARIO', cognome: 'ROSSI (DATO FITTIZIO)', titolarita: 'Proprietà', quota: '1/2' },
        { nome: 'ANNA', cognome: 'BIANCHI (DATO FITTIZIO)', titolarita: 'Proprietà', quota: '1/2' }
      ]
    };
  }
}
