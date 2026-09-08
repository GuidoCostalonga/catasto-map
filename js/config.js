/**
 * config.js — Configurazione dell'applicazione CATASTO MAP.
 * File "classico" (non modulo) caricato prima dell'app: modificare qui gli endpoint.
 *
 * NOTA SUI PROXY: il server WMS/WFS dell'Agenzia delle Entrate non invia header CORS
 * (verificato con GetCapabilities/GetFeatureInfo): il browser non può interrogarlo
 * direttamente con fetch(). Le immagini GetMap invece si caricano senza CORS.
 * Per questo gli URL predefiniti puntano al proxy del backend (server/routes/proxy.js)
 * oppure al Cloudflare Worker (server/cloudflare-worker.js) per pubblicazioni statiche.
 */
// In locale (npm start) si usa il proxy del server Node; sul sito pubblico statico (costalonga.org, GitHub Pages)
// si usa il Cloudflare Worker deployato da server/cloudflare-worker.js.
const CATASTO_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const CATASTO_WORKER = 'https://catasto-map-proxy.guidocostalonga.workers.dev';

window.CATASTO_CONFIG = {
  APP_NAME: 'CATASTO MAP',
  VERSION: '1.0.0',

  // null = automatico (true su localhost/127.0.0.1). In modalità sviluppo si attivano checkServices() e i dati demo.
  DEV_MODE: null,

  // Backend applicativo (Node). '' = stessa origine. Es.: 'https://catasto-api.example.org'
  BACKEND_API_URL: '',

  // ---- Servizi cartografici ufficiali Agenzia delle Entrate (CC BY 4.0) ----
  // URL usati dal frontend (di norma il proxy). Per un proxy esterno: 'https://<worker>.workers.dev/wms'
  CATASTO_WMS_URL: CATASTO_LOCAL ? '/proxy/wms/catasto' : CATASTO_WORKER + '/wms/catasto',
  CATASTO_WFS_URL: CATASTO_LOCAL ? '/proxy/wfs/catasto' : CATASTO_WORKER + '/wfs/catasto',
  // Endpoint reali (documentati sul Geoportale Cartografico Catastale). Usati per l'attribuzione e dal proxy.
  CATASTO_WMS_UPSTREAM: 'https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php',
  CATASTO_WFS_UPSTREAM: 'https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php',
  CATASTO_ATTRIBUTION: '© <a href="https://www.agenziaentrate.gov.it/" target="_blank" rel="noopener">Agenzia delle Entrate</a> – Cartografia catastale, CC BY 4.0',
  // CRS geografico esposto dal WMS (non supporta EPSG:3857: OpenLayers riproietta le tile)
  CATASTO_WMS_CRS: 'EPSG:4258',
  // Layer WMS (nomi reali da GetCapabilities) raggruppati per livello logico e scala di visibilità
  CATASTO_WMS_GROUPS: [
    { id: 'fogli', title: 'Fogli di mappa', layers: 'CP.CadastralZoning', minZoom: 11, maxZoomServer: 200000, defaultOn: true },
    { id: 'particelle', title: 'Particelle e fabbricati', layers: 'CP.CadastralParcel,fabbricati,acque,strade', minZoom: 15.5, maxZoomServer: 5000, defaultOn: true },
    { id: 'etichette', title: 'Numeri di particella', layers: 'vestizioni,codice_plla,simbolo_graffa', minZoom: 17, maxZoomServer: 2000, defaultOn: true }
  ],
  // 'auto' = WFS (geometrie) se disponibile, altrimenti GetFeatureInfo WMS; 'wfs' | 'wms' per forzare
  IDENTIFY_MODE: 'auto',

  // ---- Geocoder ----
  // Nominatim (OSM): ricerca completa e reverse. Politica d'uso: max 1 richiesta/s, niente autocomplete.
  GEOCODER_URL: 'https://nominatim.openstreetmap.org',
  // Photon (komoot): suggerimenti durante la digitazione (consentito). Lasciare '' per disattivare i suggerimenti.
  GEOCODER_SUGGEST_URL: 'https://photon.komoot.io/api/',
  GEOCODER_COUNTRY: 'it',
  GEOCODER_BBOX: [6.6, 35.4, 18.6, 47.2],
  // Quota del punto selezionato (Open-Meteo Elevation API, gratuita per uso non commerciale, CORS aperto). '' per disattivare.
  ELEVATION_URL: 'https://api.open-meteo.com/v1/elevation',
  // Pagine ufficiali dell'Agenzia delle Entrate per completare a mano i dati che i servizi cartografici non espongono
  ADE_LINKS: {
    rendite: 'https://www.agenziaentrate.gov.it/portale/schede/fabbricatiterreni/visura-catastale/consultazione-rendite-catastali-cittadini',
    renditeServizio: 'https://sister3.agenziaentrate.gov.it/CitizenVisure/index.do',
    visura: 'https://www.agenziaentrate.gov.it/portale/schede/fabbricatiterreni/visura-catastale/visura-catastale-online-cittadini',
    mieiImmobili: 'https://www.agenziaentrate.gov.it/portale/consulta-i-dati-dei-tuoi-immobili'
  },

  // ---- Basemap (liberamente utilizzabili con attribuzione) ----
  BASEMAPS: [
    { id: 'osm', title: 'Stradale (OpenStreetMap)', type: 'osm', default: true },
    { id: 'osm-hot', title: 'Stradale umanitaria (HOT)', type: 'xyz', url: 'https://tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', maxZoom: 19,
      attribution: '© OpenStreetMap contributors, tiles © Humanitarian OSM Team' },
    { id: 'esri-sat', title: 'Satellite (Esri World Imagery)', type: 'xyz',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19,
      attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community' },
    { id: 'none', title: 'Nessuna base', type: 'none' }
  ],

  // ---- Livelli aggiuntivi (WMS) ----
  // Ortofoto Geoportale Nazionale (MASE): il servizio risponde solo in http → va proxato in un sito https.
  EXTRA_LAYERS: [
    { id: 'pcn-orto', title: 'Ortofoto 2012 (Geoportale Nazionale)', type: 'wms', url: CATASTO_LOCAL ? '/proxy/wms/pcn' : CATASTO_WORKER + '/wms/pcn',
      layers: 'OI.ORTOIMMAGINI.2012.32,OI.ORTOIMMAGINI.2012.33', crs: 'EPSG:3857', requiresProxy: 'pcn',
      attribution: 'Ortofoto © Ministero dell\'Ambiente – Geoportale Nazionale' },
    { id: 'fvg-ctr', title: 'CTR 1:5000 Friuli Venezia Giulia', type: 'wms', url: 'https://serviziogc.regione.fvg.it/geoserver/wms',
      layers: 'TER_AMB:CTRN5KColore', crs: 'EPSG:900913', region: 'Friuli-Venezia Giulia',
      attribution: '© Regione Autonoma Friuli Venezia Giulia – CTRN' },
    { id: 'fvg-orto', title: 'Ortofoto Friuli Venezia Giulia', type: 'wms', url: 'https://irdat-ortofoto.regione.fvg.it/geoserver/ortofoto/ows',
      layers: 'trueorto_FVG_1720', crs: 'EPSG:900913', region: 'Friuli-Venezia Giulia',
      attribution: '© Regione Autonoma Friuli Venezia Giulia – Ortofoto' }
  ],

  // ---- Comportamento ----
  HOVER: { debounceMs: 250, minZoom: 15.5, cacheMax: 4000, halfDeg: 0.00025 },
  CROSSHAIR_SETTLE_MS: 400,
  DEFAULT_VIEW: { lon: 12.55, lat: 42.6, zoom: 6 },
  COMUNI_DATA_URL: 'data/comuni.json',
  HISTORY_MAX: 30,
  REQUEST_TIMEOUT_MS: 25000
};
