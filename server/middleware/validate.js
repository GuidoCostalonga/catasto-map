/**
 * validate.js — Validazione rigorosa dei parametri catastali e geografici.
 * Le particelle NON sono sempre interi: ammessi "12/3" (tavolare) e suffissi alfabetici.
 */
export class ValidationError extends Error {
  constructor(message, field) { super(message); this.status = 400; this.code = 'VALIDATION'; this.field = field; }
}

const RULES = {
  codiceComune: { re: /^[A-Z]\d{3}$/, msg: 'Codice catastale del Comune non valido (es. H609).' },
  sezione: { re: /^[A-Z0-9]{0,2}$/, msg: 'Sezione non valida.', optional: true },
  foglio: { re: /^\d{1,4}[A-Z]?(?:_?[A-Z])?$/, msg: 'Foglio non valido (es. 12, 12A, 12_B).' },
  particella: { re: /^\d{1,6}(?:\/\d{1,6})?[A-Z]?$/, msg: 'Particella non valida (es. 428, 12/3).' },
  subalterno: { re: /^[A-Z0-9]{0,6}$/, msg: 'Subalterno non valido.', optional: true },
  motivo: { re: /^[\p{L}\p{N}\s.,;:'"()/\-_°º#&€]{5,500}$/u, msg: 'Motivo della consultazione non valido (5-500 caratteri).', optional: true }
};

export function cleanString(v, max = 200) {
  return String(v ?? '').trim().slice(0, max);
}

/** Valida e normalizza un oggetto di parametri catastali. */
export function validateCadastral(src, required = ['codiceComune', 'foglio', 'particella']) {
  const out = {};
  for (const [field, rule] of Object.entries(RULES)) {
    let v = cleanString(src[field], field === 'motivo' ? 500 : 20);
    if (field !== 'motivo') v = v.toUpperCase();
    if (!v) {
      if (required.includes(field)) throw new ValidationError(`Campo obbligatorio: ${field}.`, field);
      out[field] = '';
      continue;
    }
    if (!rule.re.test(v)) throw new ValidationError(rule.msg, field);
    out[field] = v;
  }
  return out;
}

export function validateLatLon(src) {
  const lat = Number(src.lat), lon = Number(src.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new ValidationError('Coordinate non valide.', 'lat/lon');
  if (lat < 35 || lat > 48 || lon < 6 || lon > 19) throw new ValidationError('Coordinate fuori dal territorio italiano.', 'lat/lon');
  return { lat, lon };
}
