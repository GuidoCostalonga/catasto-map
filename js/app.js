/**
 * app.js — Orchestrazione dell'applicazione CATASTO MAP.
 * Collega mappa, provider catastale, geocoder, backend e interfaccia.
 */
import { MapController } from './map.js';
import { ComuniIndex, AgenziaEntrateMapProvider, MockOwnershipProvider, CatastoError } from './catasto.js';
import { Geocoder } from './geocoder.js';
import { ApiClient, ApiError } from './api.js';
import { UI, fmtCoord, fmtArea } from './ui.js';
import * as core from './catasto-core.js';

const CONFIG = window.CATASTO_CONFIG;
const DEV = CONFIG.DEV_MODE ?? /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const $ = (id) => document.getElementById(id);
const resolveUrl = (u) => (u && u.startsWith('/') && CONFIG.BACKEND_API_URL ? CONFIG.BACKEND_API_URL.replace(/\/$/, '') + u : u);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const round5 = (v) => Math.round(v * 20000) / 20000; // ~5 m

class App {
  constructor() {
    this.ui = new UI();
    this.api = new ApiClient(CONFIG.BACKEND_API_URL);
    this.geocoder = new Geocoder();
    this.comuni = new ComuniIndex(CONFIG.COMUNI_DATA_URL);
    this.map = new MapController('map', { resolveUrl });
    this.provider = new AgenziaEntrateMapProvider({
      wmsUrl: resolveUrl(CONFIG.CATASTO_WMS_URL), wfsUrl: resolveUrl(CONFIG.CATASTO_WFS_URL),
      comuni: this.comuni, geocoder: this.geocoder, api: this.api, cacheMax: CONFIG.HOVER.cacheMax
    });
    this.mock = DEV ? new MockOwnershipProvider() : null;
    this.state = {
      mode: 'navigate', selected: null, selectedPoint: null, address: null, info: null, dms: false,
      history: this.loadHistory(), points: [], hoverAbort: null, hoverMisses: new Map(), puntaLocked: false, crosshairTimer: null, servicesChecked: false
    };
  }

  /* ================= avvio ================= */
  async init() {
    const ui = this.ui, map = this.map;
    map.createMiniMap('minimap');
    this.bindMap();
    this.bindSearch();
    this.bindCatastoForm();
    this.bindLayers();
    this.bindTools();
    this.bindParcelPanel();
    this.bindAdmin();
    ui.renderHistory(this.state.history, (it) => this.openHistoryItem(it));
    ui.setZoom(map.getZoom());
    ui.el.legendImg.src = `${resolveUrl(CONFIG.CATASTO_WMS_URL)}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetLegendGraphic&SLD_VERSION=1.1.0&LAYER=Cartografia_Catastale&FORMAT=image%2Fpng&STYLE=default`;
    if (DEV) ui.el.devSection.hidden = false;
    // tasto Home: solo quando la pagina è servita via http(s) e non dalla radice del sito
    const home = $('tasto-home');
    if (home && location.protocol.startsWith('http') && location.pathname !== '/') home.hidden = false;
    this.registerServiceWorker();

    // backend (facoltativo)
    this.api.health().then(async (h) => {
      if (h) { await this.api.me().catch(() => {}); ui.setModeBadge(this.api.user); }
      ui.renderAuth(this.api.user, !!h);
      this.refreshOwnershipBlock();
    });

    // elenco Comuni
    this.comuni.ready.then(() => this.populateGeoSelects()).catch((e) => ui.toast(e.message, 'error'));

    // parametri URL
    await this.applyUrlParams();

    if (DEV) setTimeout(() => this.checkServices(true), 1500);
    window.addEventListener('resize', () => map.updateSize());
  }

  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
    navigator.serviceWorker.register('service-worker.js').catch((e) => console.warn('Service worker non registrato', e));
  }

  /* ================= mappa: hover, click, mirino ================= */
  bindMap() {
    const ui = this.ui, map = this.map;
    const hoverDebounced = debounce((lon, lat, pixel) => this.hoverQuery(lon, lat, pixel), CONFIG.HOVER.debounceMs);

    map.addEventListener('hover', (e) => {
      const { lon, lat, pixel, zoom } = e.detail;
      ui.setCoords(lon, lat, this.state.dms);
      if (!this.hoverEnabled()) return;
      if (zoom < CONFIG.HOVER.minZoom) { ui.tooltipHide(); map.setHoverFeature(null); if (this.state.mode === 'punta') ui.hudUpdate(null, { text: 'Zoomare maggiormente per interrogare il catasto' }); return; }
      ui.tooltipMove(pixel);
      const cached = this.provider.cachedAt(lon, lat);
      if (cached) {
        this.abortHover();
        const p = this.provider.describe(cached.properties.ref, cached, { source: 'cache' });
        this.showHover(p);
        return;
      }
      const missKey = `${round5(lon)},${round5(lat)}`;
      if (this.state.hoverMisses.has(missKey)) { this.showHover(null); return; }
      if (this.state.mode === 'punta' && !this.state.puntaLocked) ui.hudUpdate(null, { text: 'Interrogazione…' });
      ui.tooltipShow(null, { loading: true });
      hoverDebounced(lon, lat, pixel);
    });
    map.addEventListener('hoverend', () => { ui.tooltipHide(); map.setHoverFeature(null); this.abortHover(); });
    map.addEventListener('click', (e) => {
      if (['measure-line', 'measure-area', 'point'].includes(this.state.mode)) return;
      this.selectAt(e.detail.lon, e.detail.lat);
    });
    map.addEventListener('zoom', (e) => {
      const z = e.detail.zoom;
      ui.setZoom(z);
      ui.setZoomHint(map.isCatastoVisible() && z < CONFIG.HOVER.minZoom && z >= 9);
    });
    map.addEventListener('moveend', (e) => {
      if (this.state.mode !== 'crosshair') return;
      clearTimeout(this.state.crosshairTimer);
      this.state.crosshairTimer = setTimeout(() => this.crosshairIdentify(e.detail.lon, e.detail.lat, e.detail.zoom), CONFIG.CROSSHAIR_SETTLE_MS);
    });
    map.addEventListener('loading', (e) => { if (!e.detail && this.state.tileErrors) this.state.tileErrors = 0; });
    map.addEventListener('tileerror', debounce(() => ui.toast('Alcune tile catastali non sono state caricate: servizio AdE lento o non disponibile.', 'warn'), 4000));

    $('btn-zoom-in').addEventListener('click', () => map.view.animate({ zoom: map.getZoom() + 1, duration: 250 }));
    $('btn-zoom-out').addEventListener('click', () => map.view.animate({ zoom: map.getZoom() - 1, duration: 250 }));
    $('btn-locate-quick').addEventListener('click', () => this.locate());
    $('btn-crosshair-select').addEventListener('click', () => { const [lon, lat] = map.getCenterLonLat(); this.selectAt(lon, lat); });
  }

  hoverEnabled() {
    return ['navigate', 'punta'].includes(this.state.mode) && this.map.isCatastoVisible() && !this.ui.isMobile();
  }
  abortHover() { if (this.state.hoverAbort) { this.state.hoverAbort.abort(); this.state.hoverAbort = null; } }

  async hoverQuery(lon, lat, pixel) {
    this.abortHover();
    const ctrl = new AbortController();
    this.state.hoverAbort = ctrl;
    try {
      const p = await this.provider.identifyPoint(lat, lon, { signal: ctrl.signal, mode: 'hover' });
      if (ctrl.signal.aborted) return;
      if (!p) { this.rememberMiss(lon, lat); }
      this.showHover(p);
    } catch (err) {
      if (err.code === 'ABORTED') return;
      this.ui.tooltipShow(null, { text: err.message || 'Servizio cartografico temporaneamente non disponibile.' });
      if (this.state.mode === 'punta') this.ui.hudUpdate(null, { text: err.message });
    } finally {
      if (this.state.hoverAbort === ctrl) this.state.hoverAbort = null;
    }
  }
  rememberMiss(lon, lat) {
    const m = this.state.hoverMisses;
    m.set(`${round5(lon)},${round5(lat)}`, true);
    if (m.size > 300) m.delete(m.keys().next().value);
  }
  showHover(p) {
    this.ui.tooltipShow(p);
    const outline = (geom) => this.map.setHoverFeature(geom && (!this.state.selected || this.state.selected.ref !== p.ref) ? geom : null);
    outline(p && p.geometry);
    if (p && !p.geometry && p.geometryPromise) {
      this.state.hoverRef = p.ref;
      p.geometryPromise.then((f) => { if (f && this.state.hoverRef === p.ref && !this.ui.el.tooltip.hidden) outline(f.geometry); });
    } else {
      this.state.hoverRef = p ? p.ref : null;
    }
    if (this.state.mode === 'punta' && !this.state.puntaLocked) this.ui.hudUpdate(p);
  }

  /** Attende la geometria WFS annunciata da identifyPoint (se ancora in arrivo). */
  async resolveGeometry(p, lon, lat) {
    if (p.geometry) return p;
    if (p.geometryPromise) {
      this.ui.progress(true, 'Recupero della geometria del mappale (WFS)…');
      const f = await p.geometryPromise;
      if (f) return this.provider.describe(p.ref, f, { source: 'wfs', zoning: p.zoning || null });
      return p;
    }
    try {
      const f = await this.provider.getParcelGeometry(p.ref, { lon, lat });
      return this.provider.describe(p.ref, f, { source: 'wfs' });
    } catch (_) { return p; }
  }

  async crosshairIdentify(lon, lat, zoom) {
    if (zoom < CONFIG.HOVER.minZoom) { this.ui.crosshairUpdate(null, 'Zoomare maggiormente per interrogare il catasto'); return; }
    this.ui.crosshairUpdate(null, 'Interrogazione…');
    this.abortHover();
    const ctrl = new AbortController();
    this.state.hoverAbort = ctrl;
    try {
      const p = await this.provider.identifyPoint(lat, lon, { signal: ctrl.signal, mode: 'hover' });
      if (ctrl.signal.aborted) return;
      this.ui.crosshairUpdate(p);
      this.map.setHoverFeature(p && p.geometry ? p.geometry : null);
    } catch (err) {
      if (err.code !== 'ABORTED') this.ui.crosshairUpdate(null, err.message);
    }
  }

  /* ================= selezione particella ================= */
  async selectAt(lon, lat, { address = null, silent = false } = {}) {
    const ui = this.ui, map = this.map;
    if (map.getZoom() < CONFIG.HOVER.minZoom - 1.5) {
      ui.toast('Zoomare maggiormente per interrogare il catasto.', 'warn');
      map.flyTo(lon, lat, CONFIG.HOVER.minZoom + 1.5, 700);
      return null;
    }
    this.abortHover();
    ui.progress(true, 'Identificazione della particella…');
    ui.tooltipHide();
    try {
      let p = await this.provider.identifyPoint(lat, lon, { mode: 'click' });
      if (!p || p.onlyFoglio) {
        ui.toast(p ? 'Particella non identificabile a questo livello di zoom.' : 'Nessuna particella catastale in questo punto.', 'warn');
        return null;
      }
      // foglio/particella sono già noti: si mostra subito la scheda, poi si attende la geometria
      ui.openRightPanel();
      ui.showSkeleton(false);
      ui.renderAddress(address ? { main: address.main, sub: address.sub } : null);
      ui.renderParcel(p, null, [lon, lat]);
      if (this.state.mode === 'punta') { this.state.puntaLocked = true; ui.hudUpdate(p, { locked: true }); }
      p = await this.resolveGeometry(p, lon, lat);
      // modalità alternativa (solo WMS o WFS non disponibile): pin + scheda senza evidenziazione del mappale
      await this.applySelection(p, { point: [lon, lat], address, silent });
      return p;
    } catch (err) {
      this.handleError(err);
      return null;
    } finally {
      ui.progress(false);
    }
  }

  async applySelection(p, { point = null, address = null, silent = false, fit = true } = {}) {
    const ui = this.ui, map = this.map;
    this.state.selected = p;
    this.state.selectedPoint = point;
    this.state.address = address;
    this.state.info = await this.provider.getParcelInfo(p);
    if (p.geometry) {
      map.selectParcel(p.geometry, { label: p.particella, pin: point, fit });
    } else {
      map.clearSelection();
      if (point) map.setClickPin(point[0], point[1]);
      if (!silent) ui.toast('Geometria vettoriale non disponibile: evidenziazione del mappale non possibile con il solo WMS.', 'warn', 6000);
    }
    if (this.state.mode === 'punta') { this.state.puntaLocked = true; ui.hudUpdate(p, { locked: true }); }
    ui.openRightPanel();
    ui.showSkeleton(false);
    ui.renderAddress(address ? { main: address.main, sub: address.sub } : null);
    ui.renderParcel(p, this.state.info, point);
    this.refreshOwnershipBlock();
    this.pushHistory(p, point);
    this.updateUrl(p);
    // indirizzo e confine comunale in background
    if (!address && point) this.reverseForPanel(point);
    this.showComuneBoundary(p);
  }

  async reverseForPanel(point) {
    try {
      const r = await this.geocoder.reverse(point[0], point[1]);
      if (this.state.selectedPoint !== point) return;
      if (r.street || r.city) this.ui.renderAddress({ main: r.street || r.city, sub: [r.postcode, r.city, r.county && `(${r.county})`].filter(Boolean).join(' ') });
    } catch (_) { /* facoltativo */ }
  }

  async showComuneBoundary(p) {
    const c = this.comuni.byCodice(p.codiceComune);
    if (!c) return;
    if (this.state.boundaryFor === c.codice) return;
    try {
      const b = await this.geocoder.comuneBoundary(c.nome, c.sigla);
      if (!b || !this.state.selected || this.state.selected.codiceComune !== c.codice) return;
      this.state.boundaryFor = c.codice;
      this.map.showComuneBoundary(b.geojson);
      this.map.syncMiniMap();
    } catch (_) { /* facoltativo */ }
  }

  /* ================= ricerca rapida ================= */
  bindSearch() {
    const ui = this.ui;
    const input = ui.el.searchInput, list = ui.el.suggestions;
    let items = [], active = -1, abort = null;
    const render = () => {
      list.innerHTML = '';
      if (!items.length) { list.hidden = true; return; }
      items.forEach((it, i) => {
        const li = document.createElement('li');
        li.className = (it.kind === 'catasto' ? 's-catasto' : '') + (i === active ? ' active' : '');
        li.setAttribute('role', 'option');
        li.innerHTML = `<span class="s-label">${it.label.replace(/[<>]/g, '')}</span><span class="s-sub">${(it.sub || '').replace(/[<>]/g, '')}</span>`;
        li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(it); });
        list.appendChild(li);
      });
      list.hidden = false;
    };
    const choose = async (it) => {
      list.hidden = true; items = []; active = -1;
      if (it.kind === 'catasto') { input.value = `${it.q.comune} foglio ${it.q.foglio} particella ${it.q.particella}`; await this.runCatastoSearch(it.q); }
      else { input.value = `${it.label}${it.sub ? ', ' + it.sub : ''}`; await this.goToAddress(it); }
    };
    const suggest = debounce(async (q) => {
      if (abort) abort.abort();
      const parsed = core.parseQuickQuery(q);
      if (!parsed) { items = []; render(); return; }
      if (parsed.type === 'catasto') {
        items = [{ kind: 'catasto', label: `Ricerca catastale: foglio ${parsed.foglio}, particella ${parsed.particella}`, sub: `Comune: ${parsed.comune || '?'}${parsed.sezione ? ' · sez. ' + parsed.sezione : ''}`, q: parsed }];
        render(); return;
      }
      abort = new AbortController();
      try {
        const res = await this.geocoder.suggest(q, abort.signal);
        items = res.map((r) => ({ kind: 'address', label: r.label, sub: r.sub, lon: r.lon, lat: r.lat }));
        if (!items.length) items = [{ kind: 'hint', label: 'Premi Invio per la ricerca completa', sub: '' }];
        render();
      } catch (e) { if (e.name !== 'AbortError') { items = []; render(); } }
    }, 320);

    input.addEventListener('input', () => { active = -1; suggest(input.value); });
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(-1, active - 1); render(); e.preventDefault(); }
      else if (e.key === 'Escape') { list.hidden = true; }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (active >= 0 && items[active].kind !== 'hint') choose(items[active]);
        else ui.el.searchForm.requestSubmit();
      }
    });
    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
    ui.el.searchForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      list.hidden = true;
      const q = input.value.trim();
      if (!q) return;
      const parsed = core.parseQuickQuery(q);
      if (parsed.type === 'catasto') return this.runCatastoSearch(parsed);
      ui.progress(true, 'Ricerca dell\'indirizzo…');
      try {
        const res = await this.geocoder.search(q, { limit: 1 });
        if (!res.length) { ui.toast('Indirizzo non trovato. Prova ad aggiungere il Comune.', 'warn'); return; }
        const r = res[0];
        const a = r.address;
        await this.goToAddress({ lon: r.lon, lat: r.lat, label: [a.road, a.house_number].filter(Boolean).join(' ') || r.name || r.label.split(',')[0], sub: [a.postcode, a.city || a.town || a.village, a.county && `(${a.county})`].filter(Boolean).join(' '), bbox: r.bbox, type: r.type });
      } catch (err) { this.handleError(err); } finally { ui.progress(false); }
    });
  }

  async goToAddress(r) {
    const ui = this.ui, map = this.map;
    ui.closeSheets();
    map.setCatastoVisible(true); $('chk-catasto').checked = true;
    const isPoint = !r.bbox || (Math.abs(r.bbox[2] - r.bbox[0]) < 0.003 && Math.abs(r.bbox[3] - r.bbox[1]) < 0.003);
    ui.progress(true, 'Spostamento sulla mappa…');
    if (isPoint) await map.flyTo(r.lon, r.lat, 18.5, 1100); else await map.fitBbox(r.bbox, { maxZoom: 16 });
    ui.progress(false);
    map.setAddressMarker(r.lon, r.lat);
    if (isPoint) {
      await this.selectAt(r.lon, r.lat, { address: { main: r.label, sub: r.sub || '' } });
    } else {
      ui.toast('Area individuata. Zooma su un edificio o un terreno e clicca per la particella.', 'info', 5000);
    }
  }

  /* ================= ricerca catastale ================= */
  bindCatastoForm() {
    const ui = this.ui;
    const reg = $('f-regione'), prov = $('f-provincia'), com = $('f-comune'), info = $('f-comune-info');
    reg.addEventListener('change', () => this.populateGeoSelects());
    prov.addEventListener('change', () => this.populateComuniList());
    com.addEventListener('input', () => {
      this.populateComuniList(com.value);
      const c = this.comuni.find(com.value, prov.value || undefined);
      info.textContent = c ? `${c.nome} (${c.sigla}) — codice ${c.codice}` : '';
    });
    $('catasto-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.runCatastoSearch({ comune: com.value, sigla: prov.value || undefined, sezione: $('f-sezione').value.trim(), foglio: $('f-foglio').value.trim(), particella: $('f-particella').value.trim(), subalterno: $('f-sub').value.trim() }, ui.el.formStatus);
    });
    $('btn-history-clear').addEventListener('click', () => { this.state.history = []; this.saveHistory(); ui.renderHistory([], () => {}); });
  }

  populateGeoSelects() {
    const reg = $('f-regione'), prov = $('f-provincia');
    if (reg.options.length <= 1) for (const r of this.comuni.regioni()) reg.add(new Option(r, r));
    const cur = prov.value;
    prov.innerHTML = '<option value="">Tutte</option>';
    for (const p of this.comuni.province(reg.value || undefined)) prov.add(new Option(`${p.nome} (${p.sigla})`, p.sigla));
    if ([...prov.options].some((o) => o.value === cur)) prov.value = cur;
    this.populateComuniList();
  }
  populateComuniList(prefix = '') {
    const dl = $('f-comune-list'), prov = $('f-provincia').value, reg = $('f-regione').value;
    const list = prefix.length >= 2 ? this.comuni.search(prefix, 12, { sigla: prov || undefined, regione: reg || undefined }) : (prov ? this.comuni.comuni(prov).slice(0, 400) : []);
    dl.innerHTML = list.map((c) => `<option value="${c.nome.replace(/"/g, '&quot;')}">${c.sigla}</option>`).join('');
  }

  async runCatastoSearch(q, statusEl = null) {
    const ui = this.ui, map = this.map;
    ui.closeSheets();
    await this.comuni.ready;
    const progress = (t) => { ui.progress(true, t); if (statusEl) ui.setStatus(statusEl, t); };
    progress('Ricerca della particella…');
    try {
      const p = await this.provider.findParcel(q.comune, q.foglio, q.particella, { sezione: q.sezione || '', sigla: q.sigla, progress });
      if (q.subalterno) p.subalterno = q.subalterno;
      map.setCatastoVisible(true); $('chk-catasto').checked = true;
      // porta il foglio in vista con un volo, poi evidenzia
      await this.applySelection(p, { point: null, address: null, fit: true });
      const c = this.comuni.byCodice(p.codiceComune);
      if (statusEl) ui.setStatus(statusEl, `Trovata: ${c ? c.nome : p.codiceComune}, foglio ${p.foglioLabel}, particella ${p.particella}.`, 'ok');
      // compila il form con i dati trovati
      $('f-comune').value = c ? c.nome : ''; $('f-foglio').value = p.foglio; $('f-particella').value = p.particella;
      if (q.sezione) $('f-sezione').value = q.sezione;
      return p;
    } catch (err) {
      if (statusEl) ui.setStatus(statusEl, err.message, 'error');
      this.handleError(err);
      return null;
    } finally {
      ui.progress(false);
    }
  }

  /* ================= livelli ================= */
  bindLayers() {
    const ui = this.ui, map = this.map;
    ui.renderBasemaps(CONFIG.BASEMAPS, map.currentBasemap, (id) => map.setBasemap(id));
    map.addEventListener('basemap', (e) => ui.syncBasemap(e.detail));
    ui.renderLayers(map.listLayers(), (id, on) => {
      map.setLayerVisible(id, on);
      if (on && id.startsWith('catasto-') && !map.isCatastoVisible()) { map.setCatastoVisible(true); $('chk-catasto').checked = true; }
      const def = (CONFIG.EXTRA_LAYERS || []).find((d) => d.id === id);
      if (on && def && def.requiresProxy && def.url.startsWith('/') && this.api.available === false) ui.toast('Questo livello richiede il proxy del backend (server Node) perché il servizio risponde solo in http.', 'warn', 6000);
    });
    $('chk-catasto').addEventListener('change', (e) => { map.setCatastoVisible(e.target.checked); ui.setZoomHint(e.target.checked && map.getZoom() < CONFIG.HOVER.minZoom && map.getZoom() >= 9); if (!e.target.checked) { ui.tooltipHide(); map.setHoverFeature(null); } });
    $('catasto-opacity').addEventListener('input', (e) => map.catastoGroup.setOpacity(Number(e.target.value)));
  }

  /* ================= strumenti ================= */
  bindTools() {
    const ui = this.ui, map = this.map;
    const tools = { 'btn-measure-line': 'measure-line', 'btn-measure-area': 'measure-area', 'btn-point': 'point', 'btn-crosshair': 'crosshair' };
    for (const [id, mode] of Object.entries(tools)) $(id).addEventListener('click', () => this.setMode(this.state.mode === mode ? 'navigate' : mode));
    $('mb-crosshair').addEventListener('click', () => { ui.closeSheets(); this.setMode(this.state.mode === 'crosshair' ? 'navigate' : 'crosshair'); });
    $('btn-punta').addEventListener('click', () => this.setMode(this.state.mode === 'punta' ? 'navigate' : 'punta'));
    $('btn-gps').addEventListener('click', () => this.locate());
    $('btn-print').addEventListener('click', () => this.print(false));
    $('btn-pdf').addEventListener('click', () => this.print(true));
    $('btn-link').addEventListener('click', () => this.copyLink());
    $('btn-basemap').addEventListener('click', () => { const id = map.cycleBasemap(); ui.toast(`Base: ${CONFIG.BASEMAPS.find((b) => b.id === id).title}`); });
    $('btn-coords').addEventListener('click', () => { this.state.dms = !this.state.dms; const [lon, lat] = map.getCenterLonLat(); ui.setCoords(lon, lat, this.state.dms); ui.toast(`Coordinate in formato ${this.state.dms ? 'gradi-minuti-secondi' : 'decimale'} (clic sul valore in basso per copiarle)`); });
    ui.el.coords.addEventListener('click', () => this.copy(ui.el.coords.textContent, 'Coordinate copiate'));
    $('btn-history').addEventListener('click', () => { ui.showTab('ricerca'); if (ui.isMobile()) ui.el.panelLeft.classList.add('open'); $('history-title').scrollIntoView({ behavior: 'smooth' }); });
    $('btn-clear').addEventListener('click', () => { map.clearMeasure(); map.clearPoints(); map.clearSelection(); map.showComuneBoundary(null); this.state.boundaryFor = null; this.state.points = []; ui.renderPoints([]); this.state.selected = null; ui.closeRightPanel(); this.setMode('navigate'); history.replaceState(null, '', location.pathname); ui.toast('Mappa ripulita'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!ui.el.admin.hidden) ui.showAdmin(false); else if (this.state.mode !== 'navigate') this.setMode('navigate'); } });
  }

  setMode(mode) {
    const ui = this.ui, map = this.map;
    const prev = this.state.mode;
    this.state.mode = mode;
    ui.setMode(mode);
    map.stopMeasure(); map.stopAddPoint();
    ui.tooltipHide(); map.setHoverFeature(null); this.abortHover();
    document.querySelectorAll('.tool.active').forEach((b) => b.classList.remove('active'));
    $('btn-punta').setAttribute('aria-pressed', String(mode === 'punta'));
    $('mb-crosshair').classList.toggle('active', mode === 'crosshair');
    ui.hudShow(mode === 'punta');
    ui.crosshairShow(mode === 'crosshair');
    this.state.puntaLocked = false;
    if (mode === 'punta') {
      map.setCatastoVisible(true); $('chk-catasto').checked = true;
      ui.hudUpdate(null, { text: map.getZoom() < CONFIG.HOVER.minZoom ? 'Zoomare maggiormente per interrogare il catasto' : 'Passa il mouse sul territorio…' });
      if (ui.isMobile()) { ui.toast('Su smartphone usa il mirino centrale: sposta la mappa e seleziona.', 'info', 5000); this.setMode('crosshair'); return; }
    } else if (mode === 'crosshair') {
      map.setCatastoVisible(true); $('chk-catasto').checked = true;
      $('btn-crosshair').classList.add('active');
      const [lon, lat] = map.getCenterLonLat();
      this.crosshairIdentify(lon, lat, map.getZoom());
    } else if (mode === 'measure-line' || mode === 'measure-area') {
      $(mode === 'measure-line' ? 'btn-measure-line' : 'btn-measure-area').classList.add('active');
      ui.closeSheets();
      ui.setStatus(ui.el.toolStatus, mode === 'measure-line' ? 'Clicca sulla mappa per misurare; doppio clic per terminare. ESC per uscire.' : 'Clicca i vertici dell\'area; doppio clic per chiudere. ESC per uscire.');
      map.startMeasure(mode === 'measure-line' ? 'line' : 'area', (res) => ui.toast(`Misura: ${res}`, 'ok'));
    } else if (mode === 'point') {
      $('btn-point').classList.add('active');
      ui.closeSheets();
      ui.setStatus(ui.el.toolStatus, 'Clicca sulla mappa per aggiungere un punto. ESC per uscire.');
      map.startAddPoint((p) => { this.state.points.push(p); ui.renderPoints(this.state.points); ui.toast(`Punto ${p.label} aggiunto: ${fmtCoord(p.lon, p.lat)}`, 'ok'); });
    }
    if (mode === 'navigate') ui.setStatus(ui.el.toolStatus, '');
    if (prev !== mode) map.setCursor(mode === 'punta' || mode === 'crosshair' ? 'crosshair' : '');
  }

  async locate() {
    this.ui.progress(true, 'Rilevamento della posizione…');
    try {
      const r = await this.map.locate();
      this.ui.toast(`Posizione rilevata (±${Math.round(r.accuracy || 0)} m)`, 'ok');
    } catch (err) { this.ui.toast(err.message || 'Posizione non disponibile', 'error'); }
    finally { this.ui.progress(false); }
  }

  async copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); this.ui.toast(okMsg || 'Copiato negli appunti', 'ok'); }
    catch (_) { window.prompt('Copia manualmente:', text); }
  }

  parcelUrl(p) {
    const c = this.comuni.byCodice(p.codiceComune);
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('comune', c ? c.nome : p.codiceComune);
    u.searchParams.set('cod', p.codiceComune);
    if (p.sezione) u.searchParams.set('sezione', p.sezione);
    u.searchParams.set('foglio', p.foglioLabel);
    u.searchParams.set('particella', p.particella);
    if (p.subalterno) u.searchParams.set('sub', p.subalterno);
    return u.toString();
  }
  updateUrl(p) { history.replaceState(null, '', this.parcelUrl(p)); }
  copyLink() {
    const p = this.state.selected;
    if (!p) { this.ui.toast('Seleziona prima una particella.', 'warn'); return; }
    this.copy(this.parcelUrl(p), 'Link della particella copiato');
  }

  async applyUrlParams() {
    const sp = new URLSearchParams(location.search);
    if (sp.get('foglio') && sp.get('particella') && (sp.get('comune') || sp.get('cod'))) {
      await this.comuni.ready;
      const comune = sp.get('cod') || sp.get('comune');
      await this.runCatastoSearch({ comune, foglio: sp.get('foglio'), particella: sp.get('particella'), sezione: sp.get('sezione') || '', subalterno: sp.get('sub') || '' });
      return;
    }
    if (sp.get('lat') && sp.get('lon')) {
      const lat = +sp.get('lat'), lon = +sp.get('lon'), z = +(sp.get('z') || 17);
      this.map.view.setCenter(ol.proj.fromLonLat([lon, lat])); this.map.view.setZoom(z);
      if (sp.get('sel') === '1') setTimeout(() => this.selectAt(lon, lat), 600);
    }
  }

  /* ================= scheda ================= */
  bindParcelPanel() {
    const ui = this.ui;
    $('btn-close-right').addEventListener('click', () => ui.closeRightPanel());
    $('pa-copy').addEventListener('click', () => {
      const p = this.state.selected; if (!p) return;
      const txt = [`Comune: ${p.comune} (${p.codiceComune})${p.provincia ? ' - ' + p.provincia : ''}`, p.sezione ? `Sezione: ${p.sezione}` : null, `Foglio: ${p.foglioLabel}`, `Particella: ${p.particella}`, p.subalterno ? `Subalterno: ${p.subalterno}` : null, this.state.selectedPoint ? `Coordinate: ${fmtCoord(this.state.selectedPoint[0], this.state.selectedPoint[1])}` : null, this.state.info && this.state.info.superficieGeometrica ? `Superficie geometrica: ${fmtArea(this.state.info.superficieGeometrica)}` : null, `Riferimento: ${p.ref}`].filter(Boolean).join('\n');
      this.copy(txt, 'Dati catastali copiati');
    });
    $('pa-copy-coords').addEventListener('click', () => { const pt = this.pointForSelected(); if (pt) this.copy(fmtCoord(pt[0], pt[1]), 'Coordinate copiate'); });
    $('pa-gmaps').addEventListener('click', () => { const pt = this.pointForSelected(); if (pt) window.open(`https://www.google.com/maps?q=${pt[1].toFixed(6)},${pt[0].toFixed(6)}`, '_blank', 'noopener'); });
    $('pa-center').addEventListener('click', () => { if (!this.map.centerSelection()) { const pt = this.pointForSelected(); if (pt) this.map.flyTo(pt[0], pt[1], 18.5); } });
    $('pa-pdf').addEventListener('click', () => this.print(true));
    $('pa-visura').addEventListener('click', () => this.requestVisura());
    ui.el.ownershipForm.addEventListener('submit', (e) => { e.preventDefault(); this.consultOwnership($('o-motivo').value.trim(), $('o-sub').value.trim()); });
  }

  pointForSelected() {
    if (this.state.selectedPoint) return this.state.selectedPoint;
    const p = this.state.selected;
    if (p && p.bbox) return core.bboxCenter(p.bbox);
    return null;
  }

  refreshOwnershipBlock() {
    const ui = this.ui, user = this.api.user;
    ui.renderOwnership({
      message: user && ['OPERATOR', 'ADMIN'].includes(user.role)
        ? `Profilo ${user.role}: la consultazione degli intestatari passa dal backend autenticato e viene registrata nel log di audit (utente, data/ora, motivo, Comune, foglio, particella).`
        : 'Dati cartografici individuati correttamente.\nPer conoscere gli intestatari catastali è necessario effettuare una consultazione/visura attraverso un servizio autorizzato.',
      showForm: false, result: null
    });
  }

  requestVisura() {
    const ui = this.ui, p = this.state.selected;
    if (!p) return;
    const user = this.api.user;
    if (user && ['OPERATOR', 'ADMIN'].includes(user.role)) {
      ui.renderOwnership({ message: 'Indicare il motivo della consultazione: viene registrato nel log di audit del server.', showForm: true, result: null });
      $('o-motivo').focus();
      return;
    }
    if (this.api.available === false && this.mock) {
      ui.renderOwnership({ message: 'Backend non attivo. In modalità sviluppo è disponibile una simulazione con DATI FITTIZI (MockOwnershipProvider).', showForm: true, result: null });
      return;
    }
    ui.toast('Per la visura è necessario accedere con un profilo operatore autorizzato.', 'warn', 5000);
    ui.showAdmin(true);
    $('login-user').focus();
  }

  async consultOwnership(motivo, subalterno) {
    const ui = this.ui, p = this.state.selected;
    if (!p) return;
    if (motivo.length < 5) { ui.toast('Indicare un motivo della consultazione (almeno 5 caratteri).', 'warn'); return; }
    ui.progress(true, 'Consultazione del servizio catastale autorizzato…');
    try {
      let res;
      if (this.api.user) res = await this.provider.getOwnershipInfo(p, { motivo, subalterno });
      else if (this.mock && this.api.available === false) res = await this.mock.getOwnershipInfo(p);
      else throw new CatastoError('Visura catastale non configurata.', 'NOT_CONFIGURED');
      if (res.status !== 'ok') {
        ui.renderOwnership({ message: res.message || 'Visura catastale non configurata.', showForm: false, result: null });
        return;
      }
      ui.renderOwnership({ message: `Consultazione registrata. Motivo: ${motivo}`, showForm: false, result: res, demo: !!res.demo });
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) ui.renderOwnership({ message: err.message || 'Visura catastale non configurata.', showForm: false, result: null });
      else if (err instanceof ApiError && err.status === 403) ui.renderOwnership({ message: 'Dati dell\'intestatario non disponibili con il profilo corrente.', showForm: false, result: null });
      else this.handleError(err);
    } finally { ui.progress(false); }
  }

  /* ================= cronologia ================= */
  loadHistory() { try { return JSON.parse(localStorage.getItem('cm:history') || '[]'); } catch (_) { return []; } }
  saveHistory() { try { localStorage.setItem('cm:history', JSON.stringify(this.state.history.slice(0, CONFIG.HISTORY_MAX))); } catch (_) { /* quota */ } }
  pushHistory(p, point) {
    const h = this.state.history.filter((x) => x.ref !== p.ref);
    h.unshift({ ref: p.ref, comune: p.comune, sigla: p.sigla, codiceComune: p.codiceComune, foglioLabel: p.foglioLabel, particella: p.particella, bbox: p.bbox, point, t: Date.now() });
    this.state.history = h.slice(0, CONFIG.HISTORY_MAX);
    this.saveHistory();
    this.ui.renderHistory(this.state.history, (it) => this.openHistoryItem(it));
  }
  async openHistoryItem(it) {
    this.ui.closeSheets();
    this.ui.progress(true, 'Recupero della particella…');
    try {
      let f = this.provider.cachedByRef(it.ref);
      if (!f && it.bbox) f = await this.provider.getParcelGeometry(it.ref, { bbox: [it.bbox[0] - 0.0001, it.bbox[1] - 0.0001, it.bbox[2] + 0.0001, it.bbox[3] + 0.0001] });
      if (f) { await this.applySelection(this.provider.describe(it.ref, f, { source: 'wfs' }), { point: it.point || null }); return; }
      const r = core.parseReference(it.ref);
      await this.runCatastoSearch({ comune: it.codiceComune, foglio: r.foglioLabel, particella: r.particella, sezione: r.sezione });
    } catch (err) { this.handleError(err); } finally { this.ui.progress(false); }
  }

  /* ================= stampa / PDF ================= */
  async print(withData) {
    const ui = this.ui, p = this.state.selected;
    if (withData && !p) { ui.toast('Seleziona prima una particella.', 'warn'); return; }
    ui.progress(true, 'Preparazione della stampa…');
    let img = null;
    try { img = await this.map.snapshot(); } catch (_) { ui.toast('Immagine della mappa non esportabile (livello esterno senza CORS): la stampa conterrà solo i dati.', 'warn', 6000); }
    ui.progress(false);
    const now = new Date().toLocaleString('it-IT');
    const pt = this.pointForSelected();
    const rows = withData && p ? [
      ['Comune', `${p.comune} (${p.codiceComune})${p.provincia ? ' — ' + p.provincia : ''}`], ['Sezione', p.sezione || '—'], ['Foglio', p.foglioLabel], ['Particella', p.particella],
      ['Subalterno', p.subalterno || '—'], ['Riferimento nazionale', p.ref], ['Coordinate (WGS84)', pt ? fmtCoord(pt[0], pt[1]) : '—'],
      ['Superficie geometrica', this.state.info && this.state.info.superficieGeometrica ? fmtArea(this.state.info.superficieGeometrica) + ' (indicativa)' : '—'],
      ['Link', this.parcelUrl(p)]
    ] : [];
    ui.buildPrint({
      title: withData ? `SCHEDA PARTICELLA — Foglio ${p.foglioLabel}, Particella ${p.particella}` : 'CATASTO MAP — Stampa mappa',
      subtitle: `${withData ? p.comune + ' · ' : ''}Generata il ${now} · ${CONFIG.APP_NAME} ${CONFIG.VERSION}`,
      mapDataUrl: img, rows,
      note: 'Cartografia: Agenzia delle Entrate – Geoportale Cartografico Catastale (CC BY 4.0); base: © OpenStreetMap contributors. Documento privo di valore legale: per usi ufficiali richiedere visura/estratto di mappa. Per salvare in PDF scegliere "Salva come PDF" nella finestra di stampa.'
    });
    setTimeout(() => { window.print(); setTimeout(() => { ui.el.printArea.hidden = true; }, 500); }, 100);
  }

  /* ================= amministrazione / servizi ================= */
  bindAdmin() {
    const ui = this.ui;
    $('btn-admin').addEventListener('click', () => { ui.showAdmin(true); if (!this.state.servicesChecked) this.checkServices(false); });
    $('btn-admin-close').addEventListener('click', () => ui.showAdmin(false));
    ui.el.admin.addEventListener('click', (e) => { if (e.target === ui.el.admin) ui.showAdmin(false); });
    $('btn-check-services').addEventListener('click', () => this.checkServices(false));
    ui.el.loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const user = await this.api.login($('login-user').value.trim(), $('login-pass').value);
        ui.setModeBadge(user); ui.renderAuth(user, true); ui.toast(`Accesso effettuato: ${user.username} (${user.role})`, 'ok');
        $('login-pass').value = '';
        this.refreshOwnershipBlock();
        ui.showAdmin(false);
      } catch (err) { ui.toast(err.message || 'Accesso non riuscito', 'error'); }
    });
    ui.el.btnLogout.addEventListener('click', async () => {
      try { await this.api.logout(); } catch (_) { /* ignora */ }
      ui.setModeBadge(null); ui.renderAuth(null, true); this.refreshOwnershipBlock(); ui.toast('Sessione chiusa');
    });
  }

  async checkServices(quiet) {
    const ui = this.ui;
    this.state.servicesChecked = true;
    const items = [
      { key: 'wms', label: 'Cartografia catastale (WMS)', state: 'grey', text: 'verifica…' },
      { key: 'gfi', label: 'Identificazione particelle (GetFeatureInfo)', state: 'grey', text: 'verifica…' },
      { key: 'wfs', label: 'Geometrie particelle (WFS)', state: 'grey', text: 'verifica…' },
      { key: 'geo', label: 'Geocoding', state: 'grey', text: 'verifica…' },
      { key: 'base', label: 'Basemap', state: 'grey', text: 'verifica…' },
      { key: 'backend', label: 'Backend applicativo', state: 'grey', text: 'verifica…' },
      { key: 'visure', label: 'Visure / intestatari', state: 'grey', text: 'verifica…' }
    ];
    const set = (key, state, text, note) => { const it = items.find((i) => i.key === key); Object.assign(it, { state, text, note }); ui.renderServices(items); };
    ui.renderServices(items);
    const tasks = [];
    tasks.push(this.provider.checkServices().then((r) => {
      set('wms', r.wms.ok ? (r.wms.missing.length ? 'yellow' : 'green') : 'red', r.wms.ok ? `${r.wms.layers.length} layer` : 'non disponibile', r.wms.error || (r.wms.missing.length ? 'mancano: ' + r.wms.missing.join(', ') : `GFI: ${(r.wms.gfiFormats || []).join(', ')}`));
      set('gfi', r.gfi.ok ? 'green' : 'red', r.gfi.ok ? 'OK (text/html)' : 'non disponibile', r.gfi.sample ? 'es. ' + r.gfi.sample : r.gfi.error);
      set('wfs', r.wfs.ok ? 'green' : 'yellow', r.wfs.ok ? 'OK (solo BBOX)' : 'non disponibile', r.wfs.ok ? 'fallback su GetFeatureInfo se assente' : r.wfs.error);
    }));
    tasks.push(this.geocoder.search('Roma', { limit: 1 }).then((r) => set('geo', r.length ? 'green' : 'yellow', r.length ? 'OK (Nominatim)' : 'nessun risultato', CONFIG.GEOCODER_SUGGEST_URL ? 'suggerimenti: Photon' : 'suggerimenti disattivati')).catch((e) => set('geo', 'red', 'non disponibile', e.message)));
    tasks.push(new Promise((res) => { const im = new Image(); im.onload = () => { set('base', 'green', 'OK'); res(); }; im.onerror = () => { set('base', 'red', 'tile non caricate'); res(); }; im.src = 'https://tile.openstreetmap.org/6/33/23.png'; }));
    tasks.push(this.api.health().then(async (h) => {
      if (!h) { set('backend', 'yellow', 'non attivo', 'proxy OGC e visure non disponibili'); set('visure', 'yellow', 'Non configurato', 'richiede backend + servizio autorizzato'); return; }
      set('backend', 'green', `OK (${h.env || 'production'})`, h.version ? 'v' + h.version : '');
      try {
        const s = await this.api.services();
        const v = s.visure || {};
        set('visure', v.configured ? 'green' : 'yellow', v.configured ? `OK (${v.provider})` : 'Non configurato', v.note || '');
        if (s.proxies) set('backend', 'green', `OK (${h.env || 'production'})`, 'proxy: ' + Object.keys(s.proxies).join(', '));
      } catch (e) { set('visure', 'yellow', 'Non configurato', e.message); }
    }));
    await Promise.allSettled(tasks);
    if (DEV) ui.el.devStats.textContent = `Richieste OGC: ${this.provider.stats.requests} · cache hit: ${this.provider.stats.cacheHits} · geometrie in cache: ${this.provider.featureCache.size}`;
    if (!quiet) ui.toast('Verifica servizi completata');
  }

  /* ================= errori ================= */
  handleError(err) {
    console.error(err);
    if (err && (err instanceof CatastoError || err instanceof ApiError || err.code)) { this.ui.toast(err.message, 'error', 6000); return; }
    if (err && err.name === 'AbortError') return;
    this.ui.toast('Si è verificato un errore imprevisto. Riprovare.', 'error');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  window.catastoApp = app;
  app.init().catch((e) => { console.error(e); app.ui.toast('Errore di avvio dell\'applicazione', 'error'); });
});
