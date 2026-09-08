/**
 * map.js — Motore cartografico (OpenLayers 10, build completa globale `ol`).
 *
 * Scelta di OpenLayers: il WMS dell'Agenzia delle Entrate espone solo CRS geografici/UTM
 * (EPSG:4258, 6706, 25832-34, 3044-46) e non EPSG:3857. OpenLayers riproietta le tile raster
 * al volo, cosa che Leaflet non fa senza plugin; inoltre gestisce nativamente WMS 1.3.0
 * (ordine assi), tile grid personalizzate, vettori GML/GeoJSON e misure geodetiche.
 */
const CONFIG = window.CATASTO_CONFIG;
const WORLD = 20037508.342789244;

/* ------------------------------------------------------------------ */
/* Stili                                                                */
/* ------------------------------------------------------------------ */
const PIN_SVG = (color) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="46" viewBox="0 0 34 46"><path d="M17 1C8.2 1 1 8.1 1 16.8 1 28.5 17 45 17 45s16-16.5 16-28.2C33 8.1 25.8 1 17 1z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="17" cy="17" r="6" fill="#fff"/></svg>`);

function makeStyles() {
  const S = ol.style;
  return {
    selectedHalo: new S.Style({ stroke: new S.Stroke({ color: 'rgba(255,255,255,0.95)', width: 8 }), zIndex: 10 }),
    selected: new S.Style({
      stroke: new S.Stroke({ color: '#ff6d00', width: 3.5 }),
      fill: new S.Fill({ color: 'rgba(255, 193, 7, 0.22)' }), zIndex: 11
    }),
    mask: new S.Style({ fill: new S.Fill({ color: 'rgba(15, 23, 42, 0.30)' }), zIndex: 5 }),
    label: (text) => new S.Style({
      text: new S.Text({
        text, font: '700 15px system-ui, Segoe UI, Roboto, sans-serif', fill: new S.Fill({ color: '#ffffff' }),
        stroke: new S.Stroke({ color: 'rgba(17,24,39,0.9)', width: 4 }), overflow: true
      }), zIndex: 12
    }),
    hover: new S.Style({
      stroke: new S.Stroke({ color: '#2563eb', width: 2.5 }), fill: new S.Fill({ color: 'rgba(37,99,235,0.10)' })
    }),
    addressPin: new S.Style({ image: new S.Icon({ src: PIN_SVG('#0f4c81'), anchor: [0.5, 1], scale: 1 }) }),
    clickPin: new S.Style({
      image: new S.Circle({ radius: 7, fill: new S.Fill({ color: '#ff6d00' }), stroke: new S.Stroke({ color: '#fff', width: 2.5 }) }), zIndex: 20
    }),
    userPoint: (text) => new S.Style({
      image: new S.Icon({ src: PIN_SVG('#059669'), anchor: [0.5, 1], scale: 0.85 }),
      text: new S.Text({ text, offsetY: 12, font: '600 12px system-ui, sans-serif', fill: new S.Fill({ color: '#064e3b' }), stroke: new S.Stroke({ color: '#fff', width: 3 }) })
    }),
    measure: new S.Style({
      fill: new S.Fill({ color: 'rgba(124, 58, 237, 0.15)' }),
      stroke: new S.Stroke({ color: '#7c3aed', width: 2.5, lineDash: [8, 6] }),
      image: new S.Circle({ radius: 5, fill: new S.Fill({ color: '#7c3aed' }), stroke: new S.Stroke({ color: '#fff', width: 2 }) })
    }),
    comune: new S.Style({ stroke: new S.Stroke({ color: '#0f4c81', width: 2.5, lineDash: [10, 6] }), fill: new S.Fill({ color: 'rgba(15,76,129,0.04)' }) }),
    comuneMini: new S.Style({ stroke: new S.Stroke({ color: '#0f4c81', width: 2 }), fill: new S.Fill({ color: 'rgba(15,76,129,0.10)' }) }),
    miniExtent: new S.Style({ stroke: new S.Stroke({ color: '#ff6d00', width: 2 }), fill: new S.Fill({ color: 'rgba(255,109,0,0.15)' }) }),
    miniPoint: new S.Style({ image: new S.Circle({ radius: 5, fill: new S.Fill({ color: '#ff6d00' }), stroke: new S.Stroke({ color: '#fff', width: 2 }) }) }),
    gps: new S.Style({ image: new S.Circle({ radius: 8, fill: new S.Fill({ color: '#2563eb' }), stroke: new S.Stroke({ color: '#fff', width: 3 }) }) }),
    gpsAccuracy: new S.Style({ fill: new S.Fill({ color: 'rgba(37,99,235,0.12)' }), stroke: new S.Stroke({ color: 'rgba(37,99,235,0.5)', width: 1 }) })
  };
}

/* ------------------------------------------------------------------ */
/* Caricamento tile con ritentativo                                     */
/* ------------------------------------------------------------------ */
/**
 * Il WMS dell'Agenzia delle Entrate risponde 500 in modo sporadico sotto carico: la tile viene
 * scaricata via fetch (stessa origine, tramite proxy) con fino a 3 tentativi e consegnata a
 * OpenLayers come blob. In caso di errore definitivo la tile resta vuota senza bloccare la mappa.
 */
async function loadTileWithRetry(tile, src) {
  const img = tile.getImage();
  const MAX_ATTEMPTS = 4; // attese 0,5 s · 1 s · 2 s · 4 s (con jitter): gli errori 500 AdE durano pochi secondi
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(45000) });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        img.src = url;
        return;
      }
      if (res.status < 500 && res.status !== 429) break;
    } catch (_) { /* rete: si ritenta */ }
    if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
  }
  tile.setState(3); // ol/TileState.ERROR (la costante non è esposta dalla build completa)
}

/* ------------------------------------------------------------------ */
/* Proiezioni                                                           */
/* ------------------------------------------------------------------ */
function setupProjections() {
  const p4326 = ol.proj.get('EPSG:4326');
  for (const code of ['EPSG:4258', 'EPSG:6706']) {
    if (ol.proj.get(code)) continue;
    const proj = new ol.proj.Projection({
      code, units: 'degrees', extent: [-180, -90, 180, 90], worldExtent: [-180, -90, 180, 90],
      axisOrientation: 'neu', global: true,
      getPointResolution: p4326.getPointResolutionFunc ? p4326.getPointResolutionFunc() : undefined
    });
    ol.proj.addProjection(proj);
    ol.proj.addCoordinateTransforms('EPSG:4326', proj, (c) => c, (c) => c);
    ol.proj.addCoordinateTransforms('EPSG:3857', proj, (c) => ol.proj.toLonLat(c), (c) => ol.proj.fromLonLat(c));
  }
}

/* ------------------------------------------------------------------ */
/* Controller                                                           */
/* ------------------------------------------------------------------ */
export class MapController extends EventTarget {
  constructor(targetId, opts = {}) {
    super();
    setupProjections();
    this.styles = makeStyles();
    this.resolveUrl = opts.resolveUrl || ((u) => u);
    this.geojson = new ol.format.GeoJSON();
    this.layerRegistry = new Map();
    this.pulse = null;
    this.measureOverlays = [];
    this.userPoints = [];

    this.createBasemaps();
    this.createCatastoLayers();
    this.createExtraLayers();
    this.createVectorLayers();

    this.view = new ol.View({
      center: ol.proj.fromLonLat([CONFIG.DEFAULT_VIEW.lon, CONFIG.DEFAULT_VIEW.lat]),
      zoom: CONFIG.DEFAULT_VIEW.zoom, minZoom: 4, maxZoom: 21, constrainResolution: false,
      extent: ol.proj.transformExtent([-8, 30, 30, 52], 'EPSG:4326', 'EPSG:3857')
    });

    this.map = new ol.Map({
      target: targetId,
      layers: [...this.basemapLayers, ...this.extraLayers, this.catastoGroup, this.comuneLayer, this.hoverLayer, this.selectionLayer,
        this.measureLayer, this.pointsLayer, this.gpsLayer, this.markerLayer],
      view: this.view,
      controls: [new ol.control.Attribution({ collapsible: true, collapsed: true }), new ol.control.ScaleLine({ units: 'metric' })],
      moveTolerance: 3
    });

    this.bindEvents();
  }

  /* ---------------- Layer ---------------- */
  createBasemaps() {
    this.basemapLayers = [];
    for (const def of CONFIG.BASEMAPS) {
      let source = null;
      if (def.type === 'osm') source = new ol.source.OSM({ crossOrigin: 'anonymous' });
      else if (def.type === 'xyz') source = new ol.source.XYZ({ url: def.url, maxZoom: def.maxZoom || 19, attributions: def.attribution, crossOrigin: def.cors === false ? undefined : 'anonymous' });
      else continue;
      const layer = new ol.layer.Tile({ source, visible: !!def.default, preload: 2, properties: { id: def.id, title: def.title, kind: 'basemap' } });
      this.basemapLayers.push(layer);
      this.layerRegistry.set(def.id, layer);
    }
    this.currentBasemap = (CONFIG.BASEMAPS.find((b) => b.default) || CONFIG.BASEMAPS[0]).id;
  }

  createCatastoLayers() {
    const proj = ol.proj.get(CONFIG.CATASTO_WMS_CRS);
    // tile da 1024 px (il WMS ammette 2048): un quarto delle richieste rispetto a 512 px
    const tileGrid = ol.tilegrid.createForProjection(proj, 22, 1024);
    this.catastoLayers = [];
    for (const g of CONFIG.CATASTO_WMS_GROUPS) {
      const source = new ol.source.TileWMS({
        url: this.resolveUrl(CONFIG.CATASTO_WMS_URL),
        params: { LAYERS: g.layers, VERSION: '1.3.0', FORMAT: 'image/png', TRANSPARENT: true, STYLES: '' },
        projection: proj, tileGrid, serverType: 'mapserver', hidpi: false, crossOrigin: 'anonymous',
        transition: 150, attributions: CONFIG.CATASTO_ATTRIBUTION, cacheSize: 512,
        tileLoadFunction: loadTileWithRetry
      });
      source.on('tileloaderror', () => this.dispatchEvent(new CustomEvent('tileerror', { detail: { id: g.id } })));
      const layer = new ol.layer.Tile({ source, visible: g.defaultOn !== false, minZoom: g.minZoom, preload: 0, properties: { id: 'catasto-' + g.id, title: g.title, kind: 'catasto', minZoom: g.minZoom } });
      this.catastoLayers.push(layer);
      this.layerRegistry.set('catasto-' + g.id, layer);
    }
    this.catastoGroup = new ol.layer.Group({ layers: this.catastoLayers, properties: { id: 'catasto', title: 'Cartografia catastale' } });
  }

  createExtraLayers() {
    this.extraLayers = [];
    for (const def of CONFIG.EXTRA_LAYERS || []) {
      if (def.type !== 'wms') continue;
      const source = new ol.source.TileWMS({
        url: this.resolveUrl(def.url), params: { LAYERS: def.layers, VERSION: def.version || '1.1.1', FORMAT: def.format || 'image/jpeg', TRANSPARENT: def.transparent ?? false },
        projection: def.crs || 'EPSG:3857', attributions: def.attribution, crossOrigin: def.cors === false ? undefined : (def.url.startsWith('/') ? 'anonymous' : undefined), transition: 150
      });
      const layer = new ol.layer.Tile({ source, visible: false, opacity: def.opacity ?? 1, properties: { id: def.id, title: def.title, kind: 'extra', region: def.region || null, requiresProxy: def.requiresProxy || null } });
      this.extraLayers.push(layer);
      this.layerRegistry.set(def.id, layer);
    }
  }

  createVectorLayers() {
    const mk = (id, title, style, zIndex, extra = {}) => {
      const source = new ol.source.Vector();
      const layer = new ol.layer.Vector({ source, style, zIndex, updateWhileAnimating: true, updateWhileInteracting: true, properties: { id, title, kind: 'vector' }, ...extra });
      return layer;
    };
    this.comuneLayer = mk('comune', 'Confine comunale', this.styles.comune, 30);
    this.hoverLayer = mk('hover', 'Particella sotto il cursore', this.styles.hover, 40);
    this.selectionLayer = mk('selection', 'Particella selezionata', (f) => this.selectionStyle(f), 50);
    this.measureLayer = mk('measure', 'Misure', this.styles.measure, 60);
    this.pointsLayer = mk('points', 'Punti utente', (f) => this.styles.userPoint(f.get('label') || ''), 70);
    this.gpsLayer = mk('gps', 'Posizione GPS', (f) => (f.get('kind') === 'acc' ? this.styles.gpsAccuracy : this.styles.gps), 80);
    this.markerLayer = mk('markers', 'Marker', (f) => (f.get('kind') === 'address' ? this.styles.addressPin : this.styles.clickPin), 90);
    this.layerRegistry.set('comune', this.comuneLayer);
  }

  selectionStyle(feature) {
    const kind = feature.get('kind');
    if (kind === 'mask') return this.styles.mask;
    if (kind === 'label') return this.styles.label(feature.get('text') || '');
    return [this.styles.selectedHalo, this.styles.selected];
  }

  /* ---------------- Eventi ---------------- */
  bindEvents() {
    let raf = null;
    this.map.on('pointermove', (evt) => {
      if (evt.dragging) return;
      const pixel = evt.pixel;
      const coordinate = evt.coordinate;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = null;
        const [lon, lat] = ol.proj.toLonLat(coordinate);
        this.dispatchEvent(new CustomEvent('hover', { detail: { lon, lat, pixel, zoom: this.view.getZoom() } }));
      });
    });
    this.map.getViewport().addEventListener('pointerleave', () => this.dispatchEvent(new CustomEvent('hoverend')));
    this.map.on('singleclick', (evt) => {
      const [lon, lat] = ol.proj.toLonLat(evt.coordinate);
      this.dispatchEvent(new CustomEvent('click', { detail: { lon, lat, pixel: evt.pixel, zoom: this.view.getZoom(), originalEvent: evt.originalEvent } }));
    });
    this.map.on('moveend', () => {
      const [lon, lat] = ol.proj.toLonLat(this.view.getCenter());
      this.dispatchEvent(new CustomEvent('moveend', { detail: { lon, lat, zoom: this.view.getZoom(), extent: this.getExtentLonLat() } }));
      this.syncMiniMap();
    });
    this.view.on('change:resolution', () => this.dispatchEvent(new CustomEvent('zoom', { detail: { zoom: this.view.getZoom() } })));
    this.map.on('loadstart', () => this.dispatchEvent(new CustomEvent('loading', { detail: true })));
    this.map.on('loadend', () => this.dispatchEvent(new CustomEvent('loading', { detail: false })));
  }

  /* ---------------- Navigazione ---------------- */
  getZoom() { return this.view.getZoom(); }
  getCenterLonLat() { return ol.proj.toLonLat(this.view.getCenter()); }
  getExtentLonLat() { return ol.proj.transformExtent(this.view.calculateExtent(this.map.getSize()), 'EPSG:3857', 'EPSG:4326'); }
  getPixelFromLonLat(lon, lat) { return this.map.getPixelFromCoordinate(ol.proj.fromLonLat([lon, lat])); }
  updateSize() { this.map.updateSize(); }

  flyTo(lon, lat, zoom, duration = 900) {
    return new Promise((resolve) => {
      const target = ol.proj.fromLonLat([lon, lat]);
      const cur = this.view.getZoom();
      if (zoom !== undefined && Math.abs(cur - zoom) > 2.5 && duration > 0) {
        this.view.animate({ zoom: Math.min(cur, zoom) - 1, duration: duration * 0.4 }, { center: target, zoom, duration: duration * 0.6 }, () => resolve());
      } else {
        this.view.animate({ center: target, zoom: zoom ?? cur, duration }, () => resolve());
      }
    });
  }

  fitBbox(bbox, opts = {}) {
    const ext = ol.proj.transformExtent(bbox, 'EPSG:4326', 'EPSG:3857');
    const padding = opts.padding || this.currentPadding();
    return new Promise((resolve) => {
      this.view.fit(ext, { padding, duration: opts.duration ?? 700, maxZoom: opts.maxZoom ?? 19.5, callback: () => resolve() });
    });
  }

  currentPadding() {
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    return mobile ? [90, 30, 260, 30] : [90, 420, 60, 380];
  }

  /* ---------------- Marker ---------------- */
  setAddressMarker(lon, lat) {
    const src = this.markerLayer.getSource();
    src.getFeatures().filter((f) => f.get('kind') === 'address').forEach((f) => src.removeFeature(f));
    const f = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat])), kind: 'address' });
    src.addFeature(f);
    this.animateDrop(f, this.styles.addressPin);
  }

  setClickPin(lon, lat) {
    const src = this.markerLayer.getSource();
    src.getFeatures().filter((f) => f.get('kind') === 'pin').forEach((f) => src.removeFeature(f));
    if (lon === undefined) return;
    src.addFeature(new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat])), kind: 'pin' }));
  }

  animateDrop(feature, baseStyle) {
    const start = performance.now();
    const icon = baseStyle.getImage();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / 450);
      const ease = 1 - Math.pow(1 - t, 3);
      const s = new ol.style.Style({ image: icon.clone() });
      s.getImage().setScale(0.3 + 0.7 * ease);
      s.getImage().setOpacity(0.4 + 0.6 * ease);
      feature.setStyle(s);
      if (t < 1) requestAnimationFrame(tick); else feature.setStyle(null);
    };
    requestAnimationFrame(tick);
  }

  /* ---------------- Selezione particella ---------------- */
  setHoverFeature(geometry) {
    const src = this.hoverLayer.getSource();
    src.clear(true);
    if (!geometry) return;
    src.addFeature(new ol.Feature({ geometry: this.geojson.readGeometry(geometry, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }) }));
  }

  /**
   * Evidenzia la particella: porta il poligono in primo piano, oscura l'intorno con una maschera
   * bucata, mostra l'etichetta al centro ed esegue un'animazione "pulse" di 700 ms.
   */
  selectParcel(geometry, { label = '', animate = true, fit = true, pin = null } = {}) {
    const src = this.selectionLayer.getSource();
    src.clear(true);
    const geom = this.geojson.readGeometry(geometry, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });
    const parcel = new ol.Feature({ geometry: geom, kind: 'parcel' });
    // maschera: mondo intero con i poligoni della particella come fori
    const outer = [[-WORLD, -WORLD], [WORLD, -WORLD], [WORLD, WORLD], [-WORLD, WORLD], [-WORLD, -WORLD]];
    const polys = geom.getType() === 'Polygon' ? [geom] : geom.getPolygons();
    const mask = new ol.geom.Polygon([outer, ...polys.map((p) => p.getLinearRing(0).getCoordinates())]);
    src.addFeature(new ol.Feature({ geometry: mask, kind: 'mask' }));
    src.addFeature(parcel);
    const interior = geom.getType() === 'Polygon' ? geom.getInteriorPoint() : geom.getInteriorPoints().getPoint(0);
    src.addFeature(new ol.Feature({ geometry: interior, kind: 'label', text: label }));
    this.setHoverFeature(null);
    if (pin) this.setClickPin(pin[0], pin[1]); else this.setClickPin();
    const bbox = ol.proj.transformExtent(geom.getExtent(), 'EPSG:3857', 'EPSG:4326');
    const done = fit ? this.fitBbox(bbox) : Promise.resolve();
    if (animate) done.then(() => this.pulseSelection(geom));
    return { bbox, interior: ol.proj.toLonLat(interior.getCoordinates()) };
  }

  pulseSelection(geom) {
    this.pulse = { start: performance.now(), geom };
    if (!this.pulseBound) {
      this.pulseBound = true;
      this.selectionLayer.on('postrender', (e) => {
        if (!this.pulse) return;
        const t = Math.min(1, (performance.now() - this.pulse.start) / 700);
        const vc = ol.render.getVectorContext(e);
        vc.setStyle(new ol.style.Style({ stroke: new ol.style.Stroke({ color: `rgba(255,109,0,${(1 - t) * 0.9})`, width: 4 + 26 * t }) }));
        vc.drawGeometry(this.pulse.geom);
        if (t >= 1) this.pulse = null;
        this.map.render();
      });
    }
    this.map.render();
  }

  clearSelection() {
    this.selectionLayer.getSource().clear(true);
    this.setClickPin();
    this.pulse = null;
  }

  centerSelection() {
    const f = this.selectionLayer.getSource().getFeatures().find((x) => x.get('kind') === 'parcel');
    if (!f) return false;
    this.view.fit(f.getGeometry().getExtent(), { padding: this.currentPadding(), duration: 600, maxZoom: 19.5 });
    return true;
  }

  /* ---------------- Confine comunale ---------------- */
  showComuneBoundary(geojsonGeometry) {
    this.comuneLayer.getSource().clear(true);
    if (this.mini) this.mini.comuneSrc.clear(true);
    if (!geojsonGeometry) return;
    const g = this.geojson.readGeometry(geojsonGeometry, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });
    this.comuneLayer.getSource().addFeature(new ol.Feature({ geometry: g }));
    if (this.mini) this.mini.comuneSrc.addFeature(new ol.Feature({ geometry: g.clone() }));
  }

  /* ---------------- Basemap e livelli ---------------- */
  setBasemap(id) {
    this.currentBasemap = id;
    for (const l of this.basemapLayers) l.setVisible(l.get('id') === id);
    this.dispatchEvent(new CustomEvent('basemap', { detail: id }));
  }
  cycleBasemap() {
    const ids = CONFIG.BASEMAPS.map((b) => b.id);
    const i = ids.indexOf(this.currentBasemap);
    this.setBasemap(ids[(i + 1) % ids.length]);
    return this.currentBasemap;
  }
  setLayerVisible(id, visible) {
    const l = this.layerRegistry.get(id);
    if (l) l.setVisible(visible);
  }
  setLayerOpacity(id, opacity) {
    const l = this.layerRegistry.get(id);
    if (l) l.setOpacity(opacity);
  }
  isLayerVisible(id) { const l = this.layerRegistry.get(id); return l ? l.getVisible() : false; }
  setCatastoVisible(visible) { this.catastoGroup.setVisible(visible); }
  isCatastoVisible() { return this.catastoGroup.getVisible(); }
  listLayers() {
    const out = [];
    for (const l of this.catastoLayers) out.push({ id: l.get('id'), title: l.get('title'), visible: l.getVisible(), kind: 'catasto', minZoom: l.get('minZoom'), opacity: l.getOpacity() });
    for (const l of this.extraLayers) out.push({ id: l.get('id'), title: l.get('title'), visible: l.getVisible(), kind: 'extra', region: l.get('region'), requiresProxy: l.get('requiresProxy'), opacity: l.getOpacity() });
    out.push({ id: 'comune', title: 'Confine comunale', visible: this.comuneLayer.getVisible(), kind: 'vector' });
    return out;
  }
  setCursor(cursor) { this.map.getTargetElement().style.cursor = cursor || ''; }

  /* ---------------- Misure ---------------- */
  startMeasure(type, onDone) {
    this.stopMeasure();
    const source = this.measureLayer.getSource();
    const draw = new ol.interaction.Draw({ source, type: type === 'area' ? 'Polygon' : 'LineString', style: this.styles.measure });
    this.map.addInteraction(draw);
    this.measureDraw = draw;
    let tooltipEl, tooltip, listener;
    const fmt = (geom) => {
      if (geom.getType() === 'Polygon') {
        const a = ol.sphere.getArea(geom, { projection: 'EPSG:3857' });
        return a > 10000 ? `${(a / 10000).toFixed(3)} ha (${Math.round(a).toLocaleString('it-IT')} m²)` : `${a.toFixed(1)} m²`;
      }
      const d = ol.sphere.getLength(geom, { projection: 'EPSG:3857' });
      return d > 1000 ? `${(d / 1000).toFixed(3)} km` : `${d.toFixed(1)} m`;
    };
    const newTooltip = () => {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'measure-tooltip';
      tooltip = new ol.Overlay({ element: tooltipEl, offset: [0, -14], positioning: 'bottom-center', stopEvent: false });
      this.map.addOverlay(tooltip);
      this.measureOverlays.push(tooltip);
    };
    draw.on('drawstart', (e) => {
      newTooltip();
      const geom = e.feature.getGeometry();
      listener = geom.on('change', () => {
        tooltipEl.textContent = fmt(geom);
        tooltip.setPosition(geom.getType() === 'Polygon' ? geom.getInteriorPoint().getCoordinates() : geom.getLastCoordinate());
      });
    });
    draw.on('drawend', (e) => {
      const geom = e.feature.getGeometry();
      tooltipEl.classList.add('measure-tooltip--static');
      tooltipEl.textContent = fmt(geom);
      tooltip.setPosition(geom.getType() === 'Polygon' ? geom.getInteriorPoint().getCoordinates() : geom.getLastCoordinate());
      if (listener) ol.Observable.unByKey(listener);
      if (onDone) onDone(fmt(geom));
    });
  }
  stopMeasure() {
    if (this.measureDraw) { this.map.removeInteraction(this.measureDraw); this.measureDraw = null; }
  }
  clearMeasure() {
    this.stopMeasure();
    this.measureLayer.getSource().clear();
    this.measureOverlays.forEach((o) => this.map.removeOverlay(o));
    this.measureOverlays = [];
  }

  /* ---------------- Punti utente ---------------- */
  startAddPoint(onAdd) {
    this.stopAddPoint();
    const draw = new ol.interaction.Draw({ type: 'Point', source: this.pointsLayer.getSource() });
    draw.on('drawend', (e) => {
      const [lon, lat] = ol.proj.toLonLat(e.feature.getGeometry().getCoordinates());
      const label = `P${this.pointsLayer.getSource().getFeatures().length}`;
      e.feature.set('label', label);
      if (onAdd) onAdd({ lon, lat, label });
    });
    this.map.addInteraction(draw);
    this.pointDraw = draw;
  }
  stopAddPoint() { if (this.pointDraw) { this.map.removeInteraction(this.pointDraw); this.pointDraw = null; } }
  clearPoints() { this.pointsLayer.getSource().clear(); }
  addPoint(lon, lat, label) {
    const f = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat])), label });
    this.pointsLayer.getSource().addFeature(f);
  }

  /* ---------------- GPS ---------------- */
  locate() {
    return new Promise((resolve, reject) => {
      if (!this.geolocation) {
        this.geolocation = new ol.Geolocation({ trackingOptions: { enableHighAccuracy: true }, projection: 'EPSG:3857' });
        this.geolocation.on('change:position', () => {
          const p = this.geolocation.getPosition();
          if (!p) return;
          const src = this.gpsLayer.getSource();
          src.clear(true);
          const acc = this.geolocation.getAccuracyGeometry();
          if (acc) src.addFeature(new ol.Feature({ geometry: acc, kind: 'acc' }));
          src.addFeature(new ol.Feature({ geometry: new ol.geom.Point(p), kind: 'pos' }));
        });
      }
      const geo = this.geolocation;
      const onPos = () => {
        const p = geo.getPosition();
        if (!p) return;
        ol.Observable.unByKey(key);
        const [lon, lat] = ol.proj.toLonLat(p);
        this.flyTo(lon, lat, Math.max(this.view.getZoom(), 17.5));
        resolve({ lon, lat, accuracy: geo.getAccuracy() });
      };
      const key = geo.on('change:position', onPos);
      geo.once('error', (e) => { ol.Observable.unByKey(key); reject(new Error(e.message || 'Posizione non disponibile')); });
      geo.setTracking(true);
      setTimeout(() => { if (geo.getPosition()) onPos(); }, 50);
    });
  }

  /* ---------------- Snapshot per stampa/PDF ---------------- */
  snapshot() {
    return new Promise((resolve, reject) => {
      let done = false;
      const compose = () => {
        if (done) return;
        done = true;
        try {
          const size = this.map.getSize();
          const canvas = document.createElement('canvas');
          canvas.width = size[0]; canvas.height = size[1];
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#e5e7eb'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          this.map.getViewport().querySelectorAll('.ol-layer canvas, canvas.ol-layer').forEach((c) => {
            if (c.width === 0) return;
            const parent = c.parentNode;
            const opacity = parent && parent.style.opacity !== '' ? Number(parent.style.opacity) : (c.style.opacity === '' ? 1 : Number(c.style.opacity));
            ctx.globalAlpha = opacity;
            const tr = c.style.transform;
            const m = tr && tr.match(/^matrix\(([^)]*)\)$/);
            if (m) ctx.setTransform(...m[1].split(',').map(Number)); else ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(c, 0, 0);
          });
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = 1;
          resolve(canvas.toDataURL('image/png'));
        } catch (err) { reject(err); }
      };
      // Si cattura subito ciò che è già disegnato a schermo: aspettare il caricamento di tutte le tile
      // (evento rendercomplete) poteva richiedere decine di secondi con il server AdE lento.
      this.map.renderSync();
      setTimeout(compose, 0); // non requestAnimationFrame: in una scheda in secondo piano non verrebbe mai eseguito
    });
  }

  /* ---------------- Mini mappa ---------------- */
  createMiniMap(targetId) {
    const comuneSrc = new ol.source.Vector();
    const extentSrc = new ol.source.Vector();
    const mini = new ol.Map({
      target: targetId,
      layers: [
        new ol.layer.Tile({ source: new ol.source.OSM({ crossOrigin: 'anonymous' }) }),
        new ol.layer.Vector({ source: comuneSrc, style: this.styles.comuneMini }),
        new ol.layer.Vector({ source: extentSrc, style: (f) => (f.get('kind') === 'point' ? this.styles.miniPoint : this.styles.miniExtent) })
      ],
      view: new ol.View({ center: this.view.getCenter(), zoom: 9, minZoom: 4, maxZoom: 14 }),
      controls: [], interactions: []
    });
    mini.on('singleclick', (e) => this.view.animate({ center: e.coordinate, duration: 500 }));
    this.mini = { map: mini, comuneSrc, extentSrc };
    this.syncMiniMap();
    return mini;
  }

  syncMiniMap() {
    if (!this.mini) return;
    const z = this.view.getZoom();
    const mv = this.mini.map.getView();
    const comuneExtent = this.mini.comuneSrc.getFeatures().length ? this.mini.comuneSrc.getExtent() : null;
    const ext = this.view.calculateExtent(this.map.getSize());
    this.mini.extentSrc.clear(true);
    if (z >= 9) {
      this.mini.extentSrc.addFeature(new ol.Feature({ geometry: ol.geom.Polygon.fromExtent(ext), kind: 'extent' }));
      this.mini.extentSrc.addFeature(new ol.Feature({ geometry: new ol.geom.Point(ol.extent.getCenter(ext)), kind: 'point' }));
    }
    if (comuneExtent && z >= 12) {
      mv.fit(ol.extent.buffer(comuneExtent, ol.extent.getWidth(comuneExtent) * 0.15), { size: this.mini.map.getSize(), maxZoom: 13 });
    } else {
      mv.setCenter(this.view.getCenter());
      mv.setZoom(Math.max(5, Math.min(12, Math.round(z) - 6)));
    }
  }
}
