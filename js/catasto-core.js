/**
 * catasto-core.js
 * Funzioni pure, condivise tra browser e Node, per dialogare con i servizi
 * OGC ufficiali dell'Agenzia delle Entrate (Geoportale Cartografico Catastale).
 *
 * Nessuna dipendenza dal DOM: parsing con espressioni regolari.
 *
 * Riferimento catastale nazionale (NATIONALCADASTRALREFERENCE) come esposto dal WMS/WFS AdE:
 *   G886_001400.2317
 *   ^^^^ ^^^^^^ ^^^^
 *   |    |      particella (stringa: può contenere lettere o "/" nei sistemi tavolari)
 *   |    foglio a 4 cifre + carattere allegato + carattere sviluppo ("0" = assente)
 *   codice catastale (Belfiore) del Comune, eventualmente seguito dalla lettera di sezione
 */

export const AE_WMS_LAYERS = {
  zoning: 'CP.CadastralZoning',
  parcel: 'CP.CadastralParcel',
  buildings: 'fabbricati',
  water: 'acque',
  roads: 'strade',
  dressing: 'vestizioni',
  parcelCode: 'codice_plla',
  brace: 'simbolo_graffa',
  provinces: 'province'
};

export const AE_WFS_TYPES = {
  zoning: 'CP:CadastralZoning',
  parcel: 'CP:CadastralParcel'
};

/** Analizza un riferimento nazionale "G886_001400.2317" (particella) o "G886_001400" (foglio). */
export function parseReference(ref) {
  if (!ref) return null;
  const m = String(ref).trim().match(/^([A-Z]\d{3})([A-Z]?)_(\d{4})(\S)(\S)(?:\.(.+))?$/i);
  if (!m) return null;
  const allegato = m[4] === '0' ? '' : m[4].toUpperCase();
  const sviluppo = m[5] === '0' ? '' : m[5].toUpperCase();
  return {
    codiceComune: m[1].toUpperCase(),
    sezione: (m[2] || '').toUpperCase(),
    foglio: String(parseInt(m[3], 10)),
    foglioRaw: m[3],
    allegato,
    sviluppo,
    foglioLabel: `${parseInt(m[3], 10)}${allegato}${sviluppo ? '_' + sviluppo : ''}`,
    particella: m[6] !== undefined ? m[6] : null,
    foglioRef: `${m[1].toUpperCase()}${(m[2] || '').toUpperCase()}_${m[3]}${m[4]}${m[5]}`,
    ref: String(ref).trim().toUpperCase()
  };
}

/** Costruisce il riferimento del foglio a partire dai campi utente. */
export function buildFoglioRef({ codiceComune, sezione = '', foglio, allegato = '', sviluppo = '' }) {
  const f = String(foglio).trim();
  const digits = f.match(/^(\d+)([A-Z]?)(?:_?([A-Z]))?$/i);
  let num = f, all = allegato, svil = sviluppo;
  if (digits) {
    num = digits[1];
    if (digits[2]) all = digits[2];
    if (digits[3]) svil = digits[3];
  }
  return `${String(codiceComune).toUpperCase()}${String(sezione || '').toUpperCase()}_${num.padStart(4, '0')}${(all || '0').toUpperCase()}${(svil || '0').toUpperCase()}`;
}

export function buildParcelRef(fields) {
  return `${buildFoglioRef(fields)}.${String(fields.particella).trim()}`;
}

/** Normalizza la particella digitata dall'utente (rimuove zeri iniziali superflui ma conserva lettere e "/"). */
export function normalizeParticella(p) {
  const s = String(p || '').trim().toUpperCase();
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s;
}

/* ------------------------------------------------------------------ */
/* Costruzione URL OGC                                                  */
/* ------------------------------------------------------------------ */

function joinQuery(base, params) {
  const sep = base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?';
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return base + sep + q;
}

/**
 * URL GetFeatureInfo WMS 1.3.0 attorno a un punto (lon/lat WGS84).
 * Usa un BBOX di ~30 m in EPSG:4258 con 101x101 px, cioè scala ~1:1000: così i layer
 * "Particelle" (max 1:5000) risultano sempre interrogabili indipendentemente dallo zoom della mappa.
 * Il formato utile è text/html: text/plain e GML restituiscono solo il boundedBy (verificato).
 */
export function buildGetFeatureInfoUrl(wmsUrl, lon, lat, opts = {}) {
  const half = opts.halfDeg || 0.00013;
  const size = opts.size || 101;
  const layers = opts.layers || `${AE_WMS_LAYERS.parcel},${AE_WMS_LAYERS.zoning}`;
  const bbox = [lat - half, lon - half, lat + half, lon + half].map((v) => v.toFixed(7)).join(',');
  return joinQuery(wmsUrl, {
    SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetFeatureInfo',
    LAYERS: layers, QUERY_LAYERS: layers, STYLES: '',
    CRS: 'EPSG:4258', BBOX: bbox, WIDTH: size, HEIGHT: size,
    I: Math.floor(size / 2), J: Math.floor(size / 2),
    INFO_FORMAT: 'text/html', FEATURE_COUNT: opts.featureCount || 5
  });
}

/** URL GetFeature WFS 2.0 per BBOX (unica modalità accettata dal servizio AdE, verificata). bbox = [minLon,minLat,maxLon,maxLat]. */
export function buildWfsBboxUrl(wfsUrl, typeName, bbox, opts = {}) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const params = {
    SERVICE: 'WFS', VERSION: '2.0.0', REQUEST: 'GetFeature', TYPENAMES: typeName,
    BBOX: [minLat, minLon, maxLat, maxLon].map((v) => Number(v).toFixed(7)).join(',')
  };
  if (opts.count) params.COUNT = opts.count;
  if (opts.startIndex) params.STARTINDEX = opts.startIndex;
  return joinQuery(wfsUrl, params);
}

export function buildCapabilitiesUrl(url, service) {
  return joinQuery(url, { SERVICE: service, REQUEST: 'GetCapabilities', VERSION: service === 'WMS' ? '1.3.0' : '2.0.0' });
}

/* ------------------------------------------------------------------ */
/* Parsing risposte                                                     */
/* ------------------------------------------------------------------ */

function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

/**
 * Analizza la risposta text/html del GetFeatureInfo AdE.
 * Ritorna { parcels: [{ref, label, localId, ...}], zonings: [{ref, label, ...}] }.
 */
export function parseGetFeatureInfoHtml(html) {
  const out = { parcels: [], zonings: [], raw: [] };
  if (!html || /ServiceException/i.test(html)) return out;
  const sections = html.split(/<title>Strato\s+/i).slice(1);
  for (const sec of sections) {
    const layer = (sec.match(/^([^<]+)<\/title>/) || [])[1]?.trim();
    const rows = {};
    const re = /<th[^>]*>\s*([^<]+?)\s*<\/th>\s*<td[^>]*>([^<]*)<\/td>/gi;
    let m;
    while ((m = re.exec(sec))) {
      const k = decodeEntities(m[1]);
      const v = decodeEntities(m[2]);
      if (!(k in rows)) rows[k] = v;
    }
    out.raw.push({ layer, rows });
    if (/CadastralParcel/i.test(layer || '')) {
      const ref = rows.NationalCadastralReference || rows.NATIONALCADASTRALREFERENCE;
      const parsed = parseReference(ref);
      if (parsed) out.parcels.push({ ...parsed, label: rows.Label || rows.LABEL || parsed.particella, localId: rows['InspireId localId'] || null });
    } else if (/CadastralZoning/i.test(layer || '')) {
      const ref = rows.NationalCadastralZoningReference || rows.NATIONALCADASTRALZONINGREFERENCE;
      const parsed = parseReference(ref);
      if (parsed) {
        out.zonings.push({
          ...parsed,
          label: rows.Label || rows.LABEL || parsed.foglioLabel,
          beginLifespan: rows.beginLifespanVersion || null,
          accuracy: rows.estimatedAccuracy ? `${rows.estimatedAccuracy} ${rows.estimatedAccuracyuom || ''}`.trim() : null,
          scale: rows.originalMapscaleDenominator || null
        });
      }
    }
  }
  return out;
}

/**
 * Analizza una FeatureCollection GML 3.2 del WFS AdE in un array di feature GeoJSON-like.
 * Le coordinate del servizio sono in EPSG:6706 con ordine "lat lon"; qui vengono restituite come [lon, lat].
 */
export function parseWfsGml(xml) {
  const features = [];
  if (!xml) return features;
  if (/ServiceException/i.test(xml.slice(0, 500))) {
    const msg = (xml.match(/<!\[CDATA\[([^\]]*)\]\]>/) || [])[1] || 'Errore del servizio WFS';
    const err = new Error(msg.trim());
    err.code = 'WFS_EXCEPTION';
    throw err;
  }
  const memberRe = /<wfs:member>([\s\S]*?)<\/wfs:member>/g;
  let m;
  while ((m = memberRe.exec(xml))) {
    const chunk = m[1];
    const props = {};
    const propRe = /<CP:([A-Z_]+)>([^<]*)<\/CP:\1>/g;
    let p;
    while ((p = propRe.exec(chunk))) props[p[1]] = decodeEntities(p[2]);
    const id = (chunk.match(/gml:id="([^"]+)"/) || [])[1] || null;
    const geometry = parseGmlGeometry(chunk);
    if (!geometry) continue;
    const ref = props.NATIONALCADASTRALREFERENCE || props.NATIONALCADASTRALZONINGREFERENCE || null;
    features.push({ type: 'Feature', id, properties: { ...props, ref }, geometry, bbox: geometryBbox(geometry) });
  }
  return features;
}

function parsePosList(txt) {
  const nums = txt.trim().split(/\s+/).map(Number);
  const coords = [];
  for (let i = 0; i + 1 < nums.length; i += 2) coords.push([nums[i + 1], nums[i]]); // lat lon -> lon lat
  return coords;
}

function parseGmlGeometry(chunk) {
  const polys = [];
  const polyRe = /<gml:Polygon[^>]*>([\s\S]*?)<\/gml:Polygon>/g;
  let pm;
  while ((pm = polyRe.exec(chunk))) {
    const body = pm[1];
    const rings = [];
    const ext = body.match(/<gml:exterior>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/);
    if (ext) rings.push(parsePosList(ext[1]));
    const intRe = /<gml:interior>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
    let im;
    while ((im = intRe.exec(body))) rings.push(parsePosList(im[1]));
    if (rings.length) polys.push(rings);
  }
  if (!polys.length) return null;
  if (polys.length === 1) return { type: 'Polygon', coordinates: polys[0] };
  return { type: 'MultiPolygon', coordinates: polys };
}

export function geometryBbox(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    } else c.forEach(visit);
  };
  visit(geom.coordinates);
  return [minX, minY, maxX, maxY];
}

/* ------------------------------------------------------------------ */
/* Geometria                                                            */
/* ------------------------------------------------------------------ */

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function polygonContains(geometry, lon, lat) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polys) {
    if (!ringContains(rings[0], lon, lat)) continue;
    let inHole = false;
    for (let k = 1; k < rings.length; k++) if (ringContains(rings[k], lon, lat)) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

const toRad = (d) => (d * Math.PI) / 180;

/** Area geodetica approssimata (m²) di una geometria in lon/lat (formula sferica). */
export function geodesicArea(geometry) {
  const R = 6378137;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let total = 0;
  for (const rings of polys) {
    rings.forEach((ring, idx) => {
      let a = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x1, y1] = ring[j], [x2, y2] = ring[i];
        a += (toRad(x2) - toRad(x1)) * (2 + Math.sin(toRad(y1)) + Math.sin(toRad(y2)));
      }
      a = Math.abs((a * R * R) / 2);
      total += idx === 0 ? a : -a;
    });
  }
  return total;
}

export function bboxCenter(b) {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

export function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function bboxAround(lon, lat, halfDeg) {
  return [lon - halfDeg, lat - halfDeg, lon + halfDeg, lat + halfDeg];
}

/* ------------------------------------------------------------------ */
/* Ricerca rapida: indirizzo o query catastale?                         */
/* ------------------------------------------------------------------ */

/**
 * "Roveredo in Piano foglio 12 particella 428" -> { type:'catasto', comune, foglio, particella, sezione?, subalterno? }
 * "via Dante 4 Roveredo in Piano"               -> { type:'address', q }
 */
export function parseQuickQuery(text) {
  const q = String(text || '').trim();
  if (!q) return null;
  const s = q.replace(/\s+/g, ' ');
  const fm = s.match(/\b(?:foglio|fg\.?|f\.)\s*[:=]?\s*([0-9]+[a-z]?(?:_[a-z])?)/i);
  const pm = s.match(/\b(?:particella|part\.?|p\.lla|plla|mappale|mapp\.?|map\.?|p\.)\s*[:=]?\s*([0-9]+(?:\/[0-9]+)?[a-z]?)/i);
  if (fm && pm) {
    const sez = s.match(/\b(?:sezione|sez\.?)\s*[:=]?\s*([a-z0-9]+)/i);
    const sub = s.match(/\b(?:subalterno|sub\.?)\s*[:=]?\s*([0-9a-z]+)/i);
    let comune = s;
    [fm, pm, sez, sub].forEach((mm) => { if (mm) comune = comune.replace(mm[0], ' '); });
    comune = comune.replace(/\b(comune|di|del|c\.)\b/gi, ' ').replace(/[,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
    return { type: 'catasto', comune, foglio: fm[1], particella: pm[1], sezione: sez ? sez[1].toUpperCase() : '', subalterno: sub ? sub[1] : '' };
  }
  return { type: 'address', q: s };
}

/** Rimuove accenti/maiuscole per confronti di nomi Comune. */
export function normalizeName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
