/**
 * api.js — Client del backend applicativo (server/).
 * Gestisce credenziali (cookie HttpOnly), token CSRF (double submit via header) e messaggi d'errore.
 */
const CONFIG = window.CATASTO_CONFIG;

export class ApiError extends Error {
  constructor(message, status, code, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export class ApiClient {
  constructor(baseUrl = '') {
    this.baseUrl = (baseUrl || '').replace(/\/$/, '');
    this.csrf = null;
    this.user = null;
    this.available = null; // null = sconosciuto, true/false dopo health()
  }

  get crossOrigin() {
    return this.baseUrl && !this.baseUrl.startsWith(location.origin);
  }

  async request(path, { method = 'GET', body, timeout = CONFIG.REQUEST_TIMEOUT_MS || 20000, signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf;
    let res;
    try {
      res = await fetch(this.baseUrl + path, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: this.crossOrigin ? 'include' : 'same-origin', signal: ctrl.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new ApiError('Tempo scaduto nel contattare il server', 0, 'TIMEOUT');
      throw new ApiError('Backend non raggiungibile', 0, 'NETWORK');
    }
    clearTimeout(timer);
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || `Errore del server (${res.status})`;
      throw new ApiError(msg, res.status, (data && data.code) || 'HTTP_' + res.status, data);
    }
    return data;
  }

  async health() {
    try {
      const h = await this.request('/api/health', { timeout: 6000 });
      this.available = true;
      return h;
    } catch (err) {
      this.available = false;
      return null;
    }
  }

  services() { return this.request('/api/services', { timeout: 40000 }); }

  async me() {
    const data = await this.request('/api/auth/me');
    this.csrf = data.csrfToken || null;
    this.user = data.user || null;
    return data;
  }

  async login(username, password) {
    // ottiene il token CSRF anonimo prima del login
    if (!this.csrf) await this.me().catch(() => {});
    const data = await this.request('/api/auth/login', { method: 'POST', body: { username, password } });
    this.csrf = data.csrfToken || this.csrf;
    this.user = data.user;
    return data.user;
  }

  async logout() {
    await this.request('/api/auth/logout', { method: 'POST', body: {} });
    this.user = null;
    await this.me().catch(() => {});
  }

  /** GET /api/catasto/visura — richiede profilo OPERATOR/ADMIN e servizio autorizzato configurato lato server. */
  visura({ codiceComune, sezione, foglio, particella, subalterno, motivo }) {
    const p = new URLSearchParams({ codiceComune, foglio, particella });
    if (sezione) p.set('sezione', sezione);
    if (subalterno) p.set('subalterno', subalterno);
    if (motivo) p.set('motivo', motivo);
    return this.request('/api/catasto/visura?' + p.toString(), { timeout: 40000 });
  }

  /** Tiene traccia lato server della consultazione (audit) senza dati personali: opzionale. */
  identifyServer(lat, lon) {
    return this.request(`/api/catasto/identify?lat=${lat}&lon=${lon}`);
  }
}
