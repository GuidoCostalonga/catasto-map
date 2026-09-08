/**
 * config.js — Lettura e validazione delle variabili d'ambiente (mai esposte al frontend).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = (process.env.NODE_ENV || 'development').toLowerCase();
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

function parseJson(v, fallback) {
  if (!v) return fallback;
  try { return JSON.parse(v); } catch (_) { console.warn('Variabile JSON non valida, ignorata:', v.slice(0, 40)); return fallback; }
}

let users = parseJson(process.env.USERS_JSON, []);
const usersFile = path.join(__dirname, 'users.json');
if ((!Array.isArray(users) || !users.length) && fs.existsSync(usersFile)) {
  users = parseJson(fs.readFileSync(usersFile, 'utf8'), []);
}
users = (Array.isArray(users) ? users : []).filter((u) => u && u.username && u.passwordHash && ['OPERATOR', 'ADMIN'].includes(u.role));

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32) {
  if (env === 'production') throw new Error('SESSION_SECRET mancante o troppo corto (min 32 caratteri): impostarlo in .env');
  sessionSecret = crypto.randomBytes(48).toString('hex');
}

let ownershipProvider = (process.env.OWNERSHIP_PROVIDER || 'none').toLowerCase();
if (ownershipProvider === 'mock' && env === 'production') {
  console.error('OWNERSHIP_PROVIDER=mock non è consentito in produzione: disattivato.');
  ownershipProvider = 'none';
}

export const config = {
  env,
  isDev: env !== 'production',
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '127.0.0.1',
  behindProxy: bool(process.env.BEHIND_PROXY),
  cookieSecure: bool(process.env.COOKIE_SECURE) || bool(process.env.BEHIND_PROXY),
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  sessionSecret,
  sessionMinutes: Number(process.env.SESSION_MINUTES || 480),
  users,
  catastoWmsUrl: process.env.CATASTO_WMS_URL || 'https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php',
  catastoWfsUrl: process.env.CATASTO_WFS_URL || 'https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php',
  pcnWmsUrl: process.env.PCN_WMS_URL || '',
  extraWmsProxies: parseJson(process.env.EXTRA_WMS_PROXIES, {}),
  userAgent: process.env.UPSTREAM_USER_AGENT || 'CatastoMap/1.0 (+https://github.com/ginopizza/catasto-map)',
  geocoderUrl: process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org',
  ownershipProvider,
  ownershipApiUrl: process.env.OWNERSHIP_API_URL || '',
  ownershipApiToken: process.env.OWNERSHIP_API_TOKEN || '',
  ownershipApiTimeout: Number(process.env.OWNERSHIP_API_TIMEOUT_MS || 30000),
  requireMotivo: bool(process.env.REQUIRE_MOTIVO, true),
  auditLog: path.resolve(__dirname, '..', process.env.AUDIT_LOG || 'server/logs/audit.log'),
  accessLog: process.env.ACCESS_LOG ? path.resolve(__dirname, '..', process.env.ACCESS_LOG) : null,
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase()
};
