/**
 * server.js — Backend CATASTO MAP (Node ≥ 18, Express).
 *
 * Responsabilità:
 *  - serve il frontend statico;
 *  - proxy controllato verso i servizi OGC ufficiali (che non inviano CORS);
 *  - autenticazione a sessione (cookie HttpOnly firmato) con ruoli PUBLIC/OPERATOR/ADMIN;
 *  - API visura/intestatari collegabile a un servizio autorizzato, con audit log;
 *  - sicurezza: helmet (CSP), rate limiting, CSRF, validazione input, nessun segreto nel frontend.
 */
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { log } from './middleware/log.js';
import { accessLog } from './middleware/audit.js';
import { sessionMiddleware, csrfProtect } from './middleware/auth.js';
import proxyRouter from './routes/proxy.js';
import authRouter from './routes/auth.js';
import catastoRouter, { servicesStatus } from './routes/catasto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const app = express();
app.disable('x-powered-by');
if (config.behindProxy) app.set('trust proxy', 1);

/* ---------------- sicurezza: intestazioni ---------------- */
const connectSrc = ["'self'", 'https://nominatim.openstreetmap.org', 'https://photon.komoot.io', 'https://api.open-meteo.com', ...config.corsOrigins];
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'connect-src': connectSrc,
      'worker-src': ["'self'"],
      'manifest-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'upgrade-insecure-requests': config.cookieSecure ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: config.cookieSecure ? { maxAge: 15552000, includeSubDomains: true } : false
}));

/* ---------------- CORS restrittivo (solo origini esplicite) ---------------- */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '32kb' }));
app.use(accessLog);
app.use(sessionMiddleware);

/* ---------------- rate limiting ---------------- */
const mkLimiter = (windowMs, max, message) => rateLimit({ windowMs, max, standardHeaders: 'draft-7', legacyHeaders: false, message: { code: 'RATE_LIMIT', message } });
app.use('/api/', mkLimiter(15 * 60 * 1000, 600, 'Troppe richieste: riprovare tra qualche minuto.'));
app.use('/proxy/', mkLimiter(15 * 60 * 1000, 1500, 'Troppe richieste ai servizi cartografici: riprovare tra qualche minuto.'));
app.use('/api/auth/login', mkLimiter(15 * 60 * 1000, 10, 'Troppi tentativi di accesso: riprovare tra 15 minuti.'));
app.use('/api/catasto/visura', mkLimiter(15 * 60 * 1000, 40, 'Limite di consultazioni raggiunto.'));

/* ---------------- API ---------------- */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', env: config.env, version: pkg.version, time: new Date().toISOString() });
});
app.get('/api/services', async (req, res, next) => {
  try { res.json(await servicesStatus()); } catch (err) { next(err); }
});
app.use('/api/auth', csrfProtect, authRouter);
app.use('/api/catasto', csrfProtect, catastoRouter);
app.use('/proxy', proxyRouter);

/* ---------------- frontend statico ---------------- */
const DENY = /^\/(server|tools|node_modules|package(-lock)?\.json|\.env|\.git)/i;
app.use((req, res, next) => (DENY.test(req.path) ? res.status(404).json({ code: 'NOT_FOUND', message: 'Risorsa non disponibile' }) : next()));
app.use(express.static(ROOT, {
  index: 'index.html', dotfiles: 'deny', etag: true, maxAge: config.env === 'production' ? '1h' : 0,
  setHeaders(res, filePath) {
    if (/service-worker\.js$|index\.html$|config\.js$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    if (filePath.endsWith('manifest.json')) res.setHeader('Content-Type', 'application/manifest+json');
  }
}));
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/proxy/')) return res.status(404).json({ code: 'NOT_FOUND', message: 'Endpoint inesistente' });
  res.status(404).sendFile(path.join(ROOT, 'index.html'));
});

/* ---------------- errori: mai stack trace all'utente ---------------- */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const id = crypto.randomBytes(4).toString('hex');
  log.error(`[${id}] ${req.method} ${req.originalUrl} -> ${err.stack || err.message}`);
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ code: err.code || 'INTERNAL', message: status < 500 ? err.message : `Errore interno del server (rif. ${id}).` });
});

app.listen(config.port, config.host, () => {
  log.info(`CATASTO MAP v${pkg.version} — ${config.env} — http://${config.host}:${config.port}`);
  if (config.env !== 'production' && !process.env.SESSION_SECRET) log.warn('SESSION_SECRET non impostato: generato un segreto temporaneo (le sessioni non sopravvivono al riavvio).');
  if (config.ownershipProvider === 'mock') log.warn('OWNERSHIP_PROVIDER=mock: le visure restituiscono DATI FITTIZI (solo sviluppo).');
});
