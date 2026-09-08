/**
 * ui.js — Componenti di interfaccia: pannelli, tooltip, toast, scheda particella, bottom sheet.
 * Nessuna logica di dominio: riceve dati già pronti e li rende a video.
 */
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtCoord(lon, lat, dms = false) {
  if (!dms) return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  const f = (v, pos, neg) => {
    const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 3600 - m * 60).toFixed(1);
    return `${d}°${String(m).padStart(2, '0')}'${String(s).padStart(4, '0')}"${v >= 0 ? pos : neg}`;
  };
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
}

export function fmtArea(m2) {
  if (m2 === null || m2 === undefined) return null;
  if (m2 >= 10000) return `${(m2 / 10000).toFixed(4).replace('.', ',')} ha (${Math.round(m2).toLocaleString('it-IT')} m²)`;
  return `${Math.round(m2).toLocaleString('it-IT')} m²`;
}

export class UI {
  constructor() {
    this.el = {
      app: $('app'), searchForm: $('search-form'), searchInput: $('search-input'), suggestions: $('search-suggestions'),
      panelLeft: $('panel-left'), panelRight: $('panel-right'), tooltip: $('hover-tooltip'), crosshair: $('crosshair'),
      crosshairCard: $('crosshair-card'), crosshairInfo: $('crosshair-info'), puntaHud: $('punta-hud'), puntaBody: $('punta-hud-body'),
      progress: $('progress'), progressText: $('progress-text'), coords: $('coords-readout'), zoom: $('zoom-readout'), zoomHint: $('zoom-hint'),
      skeleton: $('parcel-skeleton'), content: $('parcel-content'), addressBlock: $('address-block'), addressLines: $('address-lines'),
      headline: $('parcel-headline'), kv: $('parcel-kv'), ownershipMsg: $('ownership-msg'), ownershipForm: $('ownership-form'),
      ownershipResult: $('ownership-result'), history: $('history-list'), toasts: $('toasts'), modeBadge: $('mode-badge'),
      admin: $('admin-modal'), services: $('services-list'), authInfo: $('auth-info'), loginForm: $('login-form'), btnLogout: $('btn-logout'),
      devSection: $('dev-section'), devStats: $('dev-stats'), printArea: $('print-area'), toolStatus: $('tool-status'), formStatus: $('catasto-form-status'),
      pointsList: $('points-list'), legendImg: $('legend-img')
    };
    this.isMobile = () => window.matchMedia('(max-width: 900px)').matches;
    this.setupTabs();
    this.setupSheets();
    this.toastTimers = new Set();
  }

  /* ---------- tab e pannelli ---------- */
  setupTabs() {
    const tabs = [...document.querySelectorAll('.tab')];
    tabs.forEach((t) => t.addEventListener('click', () => this.showTab(t.dataset.tab)));
  }
  showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); });
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  }
  setupSheets() {
    document.querySelectorAll('.mobile-bar [data-open]').forEach((b) => b.addEventListener('click', () => {
      const tab = b.dataset.open;
      const isOpen = this.el.panelLeft.classList.contains('open') && document.querySelector('.tab.active')?.dataset.tab === tab;
      this.closeSheets();
      if (!isOpen) { this.showTab(tab); this.el.panelLeft.classList.add('open'); b.classList.add('active'); }
    }));
    $('mb-scheda').addEventListener('click', () => {
      const open = this.el.panelRight.classList.contains('open');
      this.closeSheets();
      if (!open && !this.el.panelRight.hidden) this.el.panelRight.classList.add('open');
    });
    $('btn-menu').addEventListener('click', () => { const open = this.el.panelLeft.classList.contains('open'); this.closeSheets(); if (!open) this.el.panelLeft.classList.add('open'); });
    // trascinamento verso il basso per chiudere
    for (const panel of [this.el.panelLeft, this.el.panelRight]) {
      const handle = panel.querySelector('.sheet-handle');
      if (!handle) continue;
      let startY = 0;
      handle.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
      handle.addEventListener('touchend', (e) => { if (e.changedTouches[0].clientY - startY > 40) this.closeSheets(); });
      handle.addEventListener('click', () => this.closeSheets());
    }
  }
  closeSheets() {
    this.el.panelLeft.classList.remove('open');
    this.el.panelRight.classList.remove('open');
    document.querySelectorAll('.mobile-bar button').forEach((b) => b.classList.remove('active'));
  }
  openRightPanel() {
    this.el.panelRight.hidden = false;
    this.el.app.classList.remove('right-closed');
    if (this.isMobile()) { this.closeSheets(); this.el.panelRight.classList.add('open'); }
  }
  closeRightPanel() {
    if (this.isMobile()) { this.el.panelRight.classList.remove('open'); return; }
    this.el.panelRight.hidden = true;
    this.el.app.classList.add('right-closed');
  }

  /* ---------- feedback ---------- */
  toast(message, type = 'info', ms = 3800) {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = message;
    this.el.toasts.appendChild(t);
    const timer = setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 260); }, ms);
    t.addEventListener('click', () => { clearTimeout(timer); t.remove(); });
  }
  progress(show, text) {
    this.el.progress.hidden = !show;
    if (text) this.el.progressText.textContent = text;
  }
  setStatus(el, text, type = '') {
    if (!text) { el.hidden = true; return; }
    el.hidden = false; el.className = `status ${type}`; el.textContent = text;
  }
  setMode(mode) { this.el.app.dataset.mode = mode; }
  setModeBadge(user) {
    const b = this.el.modeBadge;
    b.className = 'brand-badge';
    if (!user) { b.textContent = 'PUBBLICO'; return; }
    b.textContent = user.role === 'ADMIN' ? 'ADMIN' : 'OPERATORE';
    b.classList.add(user.role === 'ADMIN' ? 'admin' : 'operator');
  }
  setCoords(lon, lat, dms) { this.el.coords.textContent = lon === undefined ? '—' : fmtCoord(lon, lat, dms); }
  setZoom(z) { this.el.zoom.textContent = `zoom ${z.toFixed(1)}`; }
  setZoomHint(show, text) { this.el.zoomHint.hidden = !show; if (text) this.el.zoomHint.textContent = text; }

  /* ---------- tooltip ---------- */
  tooltipMove(pixel) {
    const t = this.el.tooltip;
    const wrap = t.parentElement.getBoundingClientRect();
    let x = pixel[0], y = pixel[1];
    if (x + 220 > wrap.width) x = x - 240;
    if (y + 110 > wrap.height) y = y - 120;
    t.style.left = `${x}px`; t.style.top = `${y}px`;
  }
  tooltipShow(parcel, opts = {}) {
    const t = this.el.tooltip;
    t.classList.toggle('loading', !!opts.loading);
    if (opts.loading) {
      t.innerHTML = '<div class="t-muted">Interrogazione catasto…</div>';
    } else if (!parcel) {
      t.innerHTML = `<div class="t-muted">${esc(opts.text || 'Nessuna particella in questo punto')}</div>`;
    } else if (parcel.onlyFoglio) {
      t.innerHTML = `<div class="t-comune">${esc(parcel.comune)}</div><div class="t-row"><span>Foglio</span><b>${esc(parcel.foglioLabel)}</b></div><div class="t-muted">Particella non identificabile a questo livello di zoom</div>`;
    } else {
      t.innerHTML = `<div class="t-comune">${esc(parcel.comune)}${parcel.sezione ? ' · SEZ. ' + esc(parcel.sezione) : ''}</div>
        <div class="t-row"><span>Foglio</span><b>${esc(parcel.foglioLabel)}</b></div>
        <div class="t-row"><span>Particella</span><b>${esc(parcel.particella)}</b></div>`;
    }
    t.hidden = false;
  }
  tooltipHide() { this.el.tooltip.hidden = true; }

  /* ---------- HUD punta e scopri ---------- */
  hudShow(show) { this.el.puntaHud.hidden = !show; if (!show) this.el.puntaHud.classList.remove('locked'); }
  hudUpdate(parcel, { locked = false, text } = {}) {
    this.el.puntaHud.classList.toggle('locked', locked);
    if (text) { this.el.puntaBody.innerHTML = `<small>${esc(text)}</small>`; return; }
    if (!parcel) { this.el.puntaBody.innerHTML = '<small>Nessuna particella sotto il puntatore</small>'; return; }
    if (parcel.onlyFoglio) { this.el.puntaBody.innerHTML = `FOGLIO ${esc(parcel.foglioLabel)}<small>${esc(parcel.comune)} — zoomare per la particella</small>`; return; }
    this.el.puntaBody.innerHTML = `FOGLIO ${esc(parcel.foglioLabel)} · PARTICELLA ${esc(parcel.particella)}<small>${esc(parcel.comune)}${parcel.provincia ? ' (' + esc(parcel.sigla) + ')' : ''}${locked ? ' — selezione bloccata' : ''}</small>`;
  }

  /* ---------- mirino ---------- */
  crosshairShow(show) {
    this.el.crosshair.hidden = !show;
    this.el.crosshairCard.hidden = !show;
    if (show) this.crosshairUpdate(null, 'Sposta la mappa sotto il mirino');
  }
  crosshairUpdate(parcel, text) {
    const b = $('btn-crosshair-select');
    if (text) { this.el.crosshairInfo.innerHTML = `<small>${esc(text)}</small>`; b.disabled = true; return; }
    if (!parcel || parcel.onlyFoglio) { this.el.crosshairInfo.innerHTML = `<small>${parcel ? 'Foglio ' + esc(parcel.foglioLabel) + ' — zoomare per la particella' : 'Nessuna particella al centro'}</small>`; b.disabled = true; return; }
    this.el.crosshairInfo.innerHTML = `Foglio ${esc(parcel.foglioLabel)} · Particella ${esc(parcel.particella)}<small>${esc(parcel.comune)}</small>`;
    b.disabled = false;
  }

  /* ---------- scheda particella ---------- */
  showSkeleton(show) { this.el.skeleton.hidden = !show; this.el.content.hidden = show; }
  renderAddress(address) {
    if (!address) { this.el.addressBlock.hidden = true; return; }
    this.el.addressBlock.hidden = false;
    this.el.addressLines.innerHTML = `<div class="a-main">${esc(address.main)}</div><div>${esc(address.sub)}</div>`;
  }
  renderParcel(parcel, info, point) {
    const p = parcel;
    this.el.headline.innerHTML = `<div class="hl"><span>FOGLIO</span><b>${esc(p.foglioLabel)}</b></div><div class="hl accent"><span>PARTICELLA</span><b>${esc(p.particella)}</b></div>`;
    const rows = [
      ['Comune', p.comune], ['Codice catastale', p.codiceComune], ['Provincia', p.provincia ? `${p.provincia} (${p.sigla})` : null], ['Regione', p.regione || null],
      ['Sezione', p.sezione || '—'], ['Foglio', p.foglioLabel + (p.allegato ? ` (allegato ${p.allegato})` : '') + (p.sviluppo ? ` (sviluppo ${p.sviluppo})` : '')],
      ['Particella', p.particella], ['Subalterno', p.subalterno || { muted: 'non pertinente / non indicato' }],
      ['Riferimento nazionale', { mono: p.ref }],
      ['Coordinate punto', point ? { mono: fmtCoord(point[0], point[1]) } : { muted: 'centroide particella' }],
      ['Superficie (geometrica)', info && info.superficieGeometrica ? fmtArea(info.superficieGeometrica) + ' ≈' : { muted: 'non disponibile (geometria assente)' }],
      ['Superficie catastale', { muted: 'non disponibile nel servizio pubblico' }],
      ['Qualità catastale', { muted: 'non disponibile nel servizio pubblico' }],
      ['Classe', { muted: 'non disponibile nel servizio pubblico' }],
      ['Reddito dominicale', { muted: 'richiede visura' }],
      ['Reddito agrario', { muted: 'richiede visura' }]
    ];
    this.el.kv.innerHTML = rows.filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => {
      if (typeof v === 'object') {
        if (v.muted) return `<dt>${esc(k)}</dt><dd class="muted">${esc(v.muted)}</dd>`;
        if (v.mono) return `<dt>${esc(k)}</dt><dd class="mono">${esc(v.mono)}</dd>`;
      }
      return `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
    }).join('');
  }
  renderOwnership({ message, showForm, result, demo }) {
    this.el.ownershipMsg.textContent = message || '';
    this.el.ownershipMsg.hidden = !message;
    this.el.ownershipForm.hidden = !showForm;
    const r = this.el.ownershipResult;
    if (!result) { r.innerHTML = ''; return; }
    const rows = (result.intestatari || []).map((i) => `<tr><td>${esc([i.cognome, i.nome].filter(Boolean).join(' '))}</td><td>${esc(i.titolarita || '')}</td><td>${esc(i.quota || '')}</td></tr>`).join('');
    r.innerHTML = `${demo || result.demo ? '<div class="demo-banner">⚠ DATI FITTIZI DI SVILUPPO — NON REALI</div>' : ''}
      <div class="hint">Fonte: ${esc(result.fonte || '—')} · Data: ${esc(result.dataVisura || '—')}</div>
      <table><thead><tr><th>Intestatario</th><th>Titolarità</th><th>Quota</th></tr></thead><tbody>${rows || '<tr><td colspan="3">Nessun intestatario restituito</td></tr>'}</tbody></table>`;
  }

  /* ---------- cronologia ---------- */
  renderHistory(items, onSelect) {
    const ul = this.el.history;
    ul.innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li');
      const d = new Date(it.t);
      li.innerHTML = `<div><div class="h-main">Fg. ${esc(it.foglioLabel)} · Part. ${esc(it.particella)}</div><div class="h-sub">${esc(it.comune)}${it.sigla ? ' (' + esc(it.sigla) + ')' : ''}</div></div><time>${d.toLocaleDateString('it-IT')} ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</time>`;
      li.addEventListener('click', () => onSelect(it));
      ul.appendChild(li);
    }
  }

  /* ---------- livelli ---------- */
  renderBasemaps(defs, current, onChange) {
    const box = $('basemap-list');
    box.innerHTML = '';
    for (const d of defs) {
      const l = document.createElement('label');
      l.innerHTML = `<input type="radio" name="basemap" value="${esc(d.id)}" ${d.id === current ? 'checked' : ''}><span>${esc(d.title)}</span>`;
      l.querySelector('input').addEventListener('change', () => onChange(d.id));
      box.appendChild(l);
    }
  }
  syncBasemap(id) { const r = document.querySelector(`input[name="basemap"][value="${id}"]`); if (r) r.checked = true; }
  renderLayers(layers, onToggle) {
    const cat = $('catasto-layer-list'), extra = $('extra-layer-list');
    cat.innerHTML = ''; extra.innerHTML = '';
    for (const l of layers) {
      const label = document.createElement('label');
      const note = l.kind === 'catasto' ? `<small>zoom ≥ ${Math.ceil(l.minZoom)}</small>` : (l.region ? `<small>${esc(l.region)}</small>` : '');
      label.innerHTML = `<input type="checkbox" ${l.visible ? 'checked' : ''} data-layer="${esc(l.id)}"><span>${esc(l.title)}</span>${note}`;
      label.querySelector('input').addEventListener('change', (e) => onToggle(l.id, e.target.checked));
      (l.kind === 'catasto' ? cat : extra).appendChild(label);
    }
  }

  /* ---------- servizi / profilo ---------- */
  renderServices(items) {
    this.el.services.innerHTML = items.map((s) => `<li><span class="dot dot-${s.state}"></span> ${esc(s.label)}: <b>${esc(s.text)}</b>${s.note ? `<small>${esc(s.note)}</small>` : ''}</li>`).join('');
  }
  renderAuth(user, backendAvailable) {
    const info = this.el.authInfo;
    if (!backendAvailable) {
      info.textContent = 'Backend non raggiungibile: profilo PUBBLICO. Avviare il server Node (npm start) per l\'accesso operatore.';
      this.el.loginForm.hidden = true; this.el.btnLogout.hidden = true; return;
    }
    if (!user) {
      info.textContent = 'Profilo PUBBLICO: navigazione, ricerca indirizzo, foglio/particella, coordinate, ricerca catastale, stampa.';
      this.el.loginForm.hidden = false; this.el.btnLogout.hidden = true; return;
    }
    info.innerHTML = `Connesso come <b>${esc(user.username)}</b> — ruolo <b>${esc(user.role)}</b>.`;
    this.el.loginForm.hidden = true; this.el.btnLogout.hidden = false;
  }
  showAdmin(show) { this.el.admin.hidden = !show; }

  renderPoints(points) {
    this.el.pointsList.innerHTML = points.map((p) => `<li>${esc(p.label)} — ${fmtCoord(p.lon, p.lat)}</li>`).join('');
  }

  /* ---------- stampa ---------- */
  buildPrint({ title, subtitle, mapDataUrl, rows, note }) {
    const area = this.el.printArea;
    area.innerHTML = `<h1>${esc(title)}</h1><div class="p-sub">${esc(subtitle)}</div>
      ${mapDataUrl ? `<img class="p-map" src="${mapDataUrl}" alt="Mappa">` : '<p>Immagine della mappa non disponibile.</p>'}
      ${rows && rows.length ? `<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
      <p class="p-note">${esc(note || '')}</p>`;
    area.hidden = false;
  }
}
