/** log.js — logger minimale a livelli, senza dipendenze. */
import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] || 20;
const ts = () => new Date().toISOString();

export const log = {
  debug: (...a) => threshold <= 10 && console.debug(ts(), 'DEBUG', ...a),
  info: (...a) => threshold <= 20 && console.log(ts(), 'INFO ', ...a),
  warn: (...a) => threshold <= 30 && console.warn(ts(), 'WARN ', ...a),
  error: (...a) => console.error(ts(), 'ERROR', ...a)
};
