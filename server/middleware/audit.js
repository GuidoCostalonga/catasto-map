/**
 * audit.js — Registro delle consultazioni di dati personali e log degli accessi.
 * Ogni riga è un oggetto JSON (formato JSON Lines), facilmente esportabile.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from './log.js';

function appendLine(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFile(file, JSON.stringify(obj) + '\n', (err) => { if (err) log.error('Scrittura log fallita', err.message); });
  } catch (err) {
    log.error('Scrittura log fallita', err.message);
  }
}

/**
 * Registra una consultazione di dati personali (visura/intestatari).
 * @param {object} e { user, role, ip, motivo, codiceComune, sezione, foglio, particella, subalterno, esito, provider }
 */
export function auditOwnershipAccess(e) {
  appendLine(config.auditLog, { ts: new Date().toISOString(), type: 'OWNERSHIP_LOOKUP', ...e });
  log.info(`AUDIT visura ${e.esito} utente=${e.user} comune=${e.codiceComune} fg=${e.foglio} part=${e.particella}`);
}

export function auditAuth(e) {
  appendLine(config.auditLog, { ts: new Date().toISOString(), type: 'AUTH', ...e });
}

/** Log degli accessi alle API (senza corpo delle richieste né dati personali). */
export function accessLog(req, res, next) {
  if (!config.accessLog || !req.path.startsWith('/api/')) return next();
  const start = Date.now();
  res.on('finish', () => {
    appendLine(config.accessLog, {
      ts: new Date().toISOString(), ip: req.ip, method: req.method, path: req.path, status: res.statusCode,
      ms: Date.now() - start, user: req.session && req.session.u ? req.session.u : null
    });
  });
  next();
}
