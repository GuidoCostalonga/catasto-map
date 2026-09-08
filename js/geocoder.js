/**
 * geocoder.js — Ricerca indirizzi, reverse geocoding e confini comunali.
 *
 * - Suggerimenti in digitazione: Photon (komoot), che consente l'autocomplete e invia CORS.
 * - Ricerca completa e reverse: Nominatim (OSM). Rispetto della policy: 1 richiesta/s,
 *   nessun autocomplete, identificazione tramite Referer del browser.
 */
const CONFIG = window.CATASTO_CONFIG;

class RateGate {
  constructor(minIntervalMs) { this.min = minIntervalMs; this.last = 0; }
  async wait() {
    const now = Date.now();
    const delta = now - this.last;
    if (delta < this.min) await new Promise((r) => setTimeout(r, this.min - delta));
    this.last = Date.now();
  }
}

export class Geocoder {
  constructor() {
    this.nominatimGate = new RateGate(1100);
    this.cache = new Map();
    this.suggestAbort = null;
  }

  get bbox() { return CONFIG.GEOCODER_BBOX || [6.6, 35.4, 18.6, 47.2]; }

  /** Suggerimenti rapidi (Photon). Ritorna [{label, sub, lon, lat, type}] */
  async suggest(q, signal) {
    if (!CONFIG.GEOCODER_SUGGEST_URL || q.trim().length < 3) return [];
    const b = this.bbox;
    const url = `${CONFIG.GEOCODER_SUGGEST_URL}?q=${encodeURIComponent(q)}&limit=7&lang=default&bbox=${b.join(',')}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error('Servizio suggerimenti non disponibile');
    const json = await res.json();
    return (json.features || []).map((f) => {
      const p = f.properties || {};
      const parts = [];
      if (p.name && p.name !== p.street) parts.push(p.name);
      if (p.street) parts.push(p.street + (p.housenumber ? ' ' + p.housenumber : ''));
      const label = parts.join(', ') || p.city || p.county || '';
      const sub = [p.postcode, p.city || p.town || p.village, p.county && `(${p.county})`].filter(Boolean).join(' ');
      return { label, sub, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], type: p.type, osmKey: p.osm_key, osmValue: p.osm_value, props: p };
    });
  }

  /** Ricerca completa (Nominatim): [{label, lon, lat, boundingbox, address}] */
  async search(q, opts = {}) {
    const key = 'search:' + q.toLowerCase() + JSON.stringify(opts);
    if (this.cache.has(key)) return this.cache.get(key);
    await this.nominatimGate.wait();
    const params = new URLSearchParams({
      q, format: 'jsonv2', addressdetails: '1', limit: String(opts.limit || 5),
      countrycodes: CONFIG.GEOCODER_COUNTRY || 'it', 'accept-language': 'it'
    });
    if (opts.polygon) { params.set('polygon_geojson', '1'); params.set('polygon_threshold', String(opts.polygonThreshold || 0.0002)); }
    if (opts.featureType) params.set('featureType', opts.featureType);
    const res = await fetch(`${CONFIG.GEOCODER_URL}/search?${params}`, { signal: opts.signal });
    if (!res.ok) throw new Error('Servizio di geocodifica temporaneamente non disponibile');
    const json = await res.json();
    const out = json.map((r) => ({
      label: r.display_name, name: r.name, lon: +r.lon, lat: +r.lat,
      bbox: r.boundingbox ? [+r.boundingbox[2], +r.boundingbox[0], +r.boundingbox[3], +r.boundingbox[1]] : null,
      address: r.address || {}, category: r.category, type: r.type, osmType: r.osm_type, osmId: r.osm_id, geojson: r.geojson || null
    }));
    this.cache.set(key, out);
    return out;
  }

  /** Reverse geocoding (Nominatim) → { label, address } */
  async reverse(lon, lat, signal) {
    const key = `rev:${lon.toFixed(5)},${lat.toFixed(5)}`;
    if (this.cache.has(key)) return this.cache.get(key);
    await this.nominatimGate.wait();
    const params = new URLSearchParams({ lat: String(lat), lon: String(lon), format: 'jsonv2', zoom: '18', addressdetails: '1', 'accept-language': 'it' });
    const res = await fetch(`${CONFIG.GEOCODER_URL}/reverse?${params}`, { signal });
    if (!res.ok) throw new Error('Reverse geocoding non disponibile');
    const r = await res.json();
    const a = r.address || {};
    const out = {
      label: r.display_name || '',
      street: [a.road, a.house_number].filter(Boolean).join(' '),
      city: a.city || a.town || a.village || a.municipality || '',
      county: a.county || '', state: a.state || '', postcode: a.postcode || '', address: a
    };
    this.cache.set(key, out);
    return out;
  }

  /**
   * Confine e bounding box di un Comune (relation OSM boundary=administrative, place_rank 16).
   * Ritorna { bbox, geojson, lon, lat, label } o null.
   */
  async comuneBoundary(nome, provinciaSigla, signal) {
    const key = `comune:${nome}|${provinciaSigla || ''}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const q = provinciaSigla ? `${nome}, ${provinciaSigla}, Italia` : `${nome}, Italia`;
    let results = await this.search(q, { polygon: true, limit: 5, signal, polygonThreshold: 0.0005 });
    let hit = results.find((r) => r.category === 'boundary' && r.type === 'administrative');
    if (!hit) {
      results = await this.search(nome, { polygon: true, limit: 8, signal, featureType: 'settlement', polygonThreshold: 0.0005 });
      hit = results.find((r) => r.category === 'boundary' && r.type === 'administrative') || results[0];
    }
    if (!hit) return null;
    const out = { bbox: hit.bbox, geojson: hit.geojson, lon: hit.lon, lat: hit.lat, label: hit.label };
    this.cache.set(key, out);
    return out;
  }
}
