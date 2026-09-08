/**
 * auth.js — Login/logout/profilo. Utenti definiti lato server (USERS_JSON o server/users.json).
 */
import { Router } from 'express';
import { newSession, clearSession, findUser, verifyPassword } from '../middleware/auth.js';
import { auditAuth } from '../middleware/audit.js';
import { cleanString } from '../middleware/validate.js';

const router = Router();

/** GET /api/auth/me — profilo corrente e token CSRF (crea una sessione anonima se assente). */
router.get('/me', (req, res) => {
  let s = req.session;
  if (!s) s = newSession(res, null);
  res.json({ user: req.user, csrfToken: s.csrf, roles: ['PUBLIC', 'OPERATOR', 'ADMIN'] });
});

/** POST /api/auth/login { username, password } */
router.post('/login', (req, res) => {
  const username = cleanString(req.body && req.body.username, 64);
  const password = String((req.body && req.body.password) || '').slice(0, 256);
  const user = findUser(username);
  // il confronto avviene comunque per non rivelare l'esistenza dell'utente (tempo costante)
  const ok = user ? verifyPassword(password, user.passwordHash) : (verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAA'), false);
  auditAuth({ event: ok ? 'LOGIN_OK' : 'LOGIN_FAIL', user: username, ip: req.ip });
  if (!ok) return res.status(401).json({ code: 'BAD_CREDENTIALS', message: 'Credenziali non valide.' });
  const s = newSession(res, user); // rotazione della sessione al login
  res.json({ user: { username: user.username, role: user.role }, csrfToken: s.csrf });
});

/** POST /api/auth/logout */
router.post('/logout', (req, res) => {
  if (req.user) auditAuth({ event: 'LOGOUT', user: req.user.username, ip: req.ip });
  clearSession(res);
  res.json({ ok: true });
});

export default router;
