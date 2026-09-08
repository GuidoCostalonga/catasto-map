/**
 * auth.js — Sessioni sicure con cookie HttpOnly firmato (HMAC-SHA256), ruoli e protezione CSRF.
 *
 * - Cookie `cm_session`: HttpOnly, SameSite=Strict (Lax con CORS esplicito), Secure in produzione/HTTPS.
 * - Payload: { u: username, r: ruolo, exp, csrf } firmato; nessun dato sensibile nel cookie.
 * - CSRF: double submit — l'header X-CSRF-Token deve coincidere con il token della sessione
 *   per tutte le richieste non sicure (POST/PUT/PATCH/DELETE).
 * - Password: scrypt con salt casuale, confronto in tempo costante.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';

const COOKIE = 'cm_session';
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(data) {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
}

export function encodeSession(payload) {
  const data = b64u(JSON.stringify(payload));
  return `${data}.${sign(data)}`;
}

export function decodeSession(token) {
  if (!token || typeof token !== 'string') return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = sign(data);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (_) { return null; }
}

function cookieOptions() {
  return {
    httpOnly: true, secure: config.cookieSecure, sameSite: config.corsOrigins.length ? 'lax' : 'strict',
    path: '/', maxAge: config.sessionMinutes * 60 * 1000
  };
}

export function newSession(res, user) {
  const payload = { u: user ? user.username : null, r: user ? user.role : 'PUBLIC', exp: Date.now() + config.sessionMinutes * 60 * 1000, csrf: crypto.randomBytes(24).toString('base64url'), iat: Date.now() };
  res.cookie(COOKIE, encodeSession(payload), cookieOptions());
  return payload;
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

/** Middleware: decodifica la sessione (anonima o autenticata) e la espone in req.session. */
export function sessionMiddleware(req, res, next) {
  req.session = decodeSession(req.cookies && req.cookies[COOKIE]) || null;
  req.user = req.session && req.session.u ? { username: req.session.u, role: req.session.r } : null;
  next();
}

/** Middleware CSRF per metodi non sicuri. */
export function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.get('X-CSRF-Token');
  if (!req.session || !token || token !== req.session.csrf) {
    return res.status(403).json({ code: 'CSRF', message: 'Token di sicurezza mancante o non valido: ricaricare la pagina.' });
  }
  next();
}

/** Middleware di autorizzazione per ruolo. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Accesso richiesto.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ code: 'FORBIDDEN', message: 'Dati non disponibili con il profilo corrente.' });
    next();
  };
}

/* ---------------- password ---------------- */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  const ref = Buffer.from(hash, 'base64url');
  return calc.length === ref.length && crypto.timingSafeEqual(calc, ref);
}

export function findUser(username) {
  return config.users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase()) || null;
}
