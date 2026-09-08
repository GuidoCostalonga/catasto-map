/**
 * hash-password.js — Utilità per creare utenti e segreti.
 *   npm run hash-password -- "password-sicura"      → hash scrypt da inserire in USERS_JSON
 *   npm run hash-password -- --secret                → SESSION_SECRET casuale
 */
import crypto from 'node:crypto';

const arg = process.argv[2];
if (!arg) {
  console.log('Uso:\n  node tools/hash-password.js "password"   → hash per USERS_JSON\n  node tools/hash-password.js --secret      → SESSION_SECRET');
  process.exit(1);
}
if (arg === '--secret') {
  console.log(crypto.randomBytes(48).toString('hex'));
  process.exit(0);
}
const salt = crypto.randomBytes(16).toString('base64url');
const hash = crypto.scryptSync(arg, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url');
const h = `scrypt$${salt}$${hash}`;
console.log('passwordHash:', h);
console.log('\nEsempio USERS_JSON:');
console.log(JSON.stringify([{ username: 'operatore', role: 'OPERATOR', passwordHash: h }]));
