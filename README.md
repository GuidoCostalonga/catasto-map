# CATASTO MAP

WebGIS professionale per individuare su mappa un terreno o un fabbricato e leggerne subito **foglio e particella catastale**, usando la cartografia ufficiale dell'Agenzia delle Entrate (Geoportale Cartografico Catastale, licenza CC BY 4.0).

Funziona in due direzioni:

- **dalla mappa al catasto**: cerca un indirizzo, passa il mouse sul territorio, leggi foglio e particella nel tooltip, clicca per evidenziare l'intero mappale e aprire la scheda;
- **dal catasto alla mappa**: inserisci Comune, foglio e particella (o scrivi «Roveredo in Piano foglio 12 particella 200» nella barra) e premi **Trova sulla mappa**.

**Online**: https://costalonga.org/catasto-map/ (frontend statico su GitHub Pages; proxy OGC sul Cloudflare Worker `catasto-map-proxy`). In questa versione pubblica il profilo è sempre PUBBLICO: login e visure richiedono il backend Node descritto sotto.

La consultazione degli **intestatari** è progettata separatamente, dietro login e solo tramite un servizio autorizzato collegato al backend: l'applicazione non fa scraping e non aggira alcuna autenticazione.

---

## Indice

1. [Requisiti](#requisiti)
2. [Installazione e avvio](#installazione-e-avvio)
3. [Struttura del progetto](#struttura-del-progetto)
4. [Configurazione](#configurazione)
   - [Frontend: js/config.js](#frontend-jsconfigjs)
   - [Backend: .env](#backend-env)
   - [WMS/WFS catastale](#wmswfs-catastale)
   - [Geocoder](#geocoder)
   - [API visure e intestatari](#api-visure-e-intestatari)
   - [Utenti e ruoli](#utenti-e-ruoli)
5. [Pubblicazione](#pubblicazione)
6. [Funzioni](#funzioni)
7. [Sicurezza](#sicurezza)
8. [Privacy](#privacy)
9. [Limitazioni dei servizi ufficiali (verificate)](#limitazioni-dei-servizi-ufficiali-verificate)
10. [Architettura a provider](#architettura-a-provider)
11. [Licenze e attribuzioni](#licenze-e-attribuzioni)

---

## Requisiti

- Node.js ≥ 18.17 (consigliato 20 o 22)
- Un browser moderno (Chrome, Edge, Firefox, Safari)
- Connessione a Internet: la cartografia catastale e le basemap sono servizi remoti

Nessun database: le sessioni sono cookie firmati, i log sono file JSON Lines.

## Installazione e avvio

```bash
cd catasto-map
npm install
cp .env.example .env          # su Windows: copy .env.example .env
npm start                     # http://127.0.0.1:8080
```

Per lo sviluppo con riavvio automatico: `npm run dev`.

Al primo avvio in `development`:

- il pannello **⚙ Servizi e profilo** esegue `checkServices()` e mostra lo stato di WMS, GetFeatureInfo, WFS, geocoder, basemap, backend e visure;
- la visura usa `MockOwnershipProvider` **solo se** `OWNERSHIP_PROVIDER=mock`: i dati sono dichiaratamente fittizi e contrassegnati con un banner.

Perché serve il server Node anche per la sola cartografia: il WMS/WFS dell'Agenzia delle Entrate **non invia intestazioni CORS**, quindi il browser non può interrogarlo via `fetch()`. Il server espone il proxy `/proxy/wms/catasto` e `/proxy/wfs/catasto` (whitelist di richieste OGC, cache, rate limiting). In alternativa, per hosting statico, c'è un [Cloudflare Worker](#pubblicazione).

## Struttura del progetto

```
catasto-map/
├─ index.html                 interfaccia (topbar, pannello sinistro, mappa, scheda particella, modale servizi)
├─ css/style.css              stile: moderno, istituzionale, responsive (bottom sheet su smartphone)
├─ js/
│  ├─ config.js               CONFIGURAZIONE FRONTEND (endpoint, basemap, livelli, comportamento)
│  ├─ app.js                  orchestrazione: ricerca, hover, selezione, strumenti, URL, PWA
│  ├─ map.js                  OpenLayers: proiezioni, WMS riproiettato, evidenziazione, misure, minimappa, GPS
│  ├─ catasto.js              provider catastali browser (AgenziaEntrateMapProvider, MockOwnershipProvider, ComuniIndex)
│  ├─ catasto-core.js         funzioni pure condivise browser/Node: URL OGC, parsing GFI/GML, riferimenti catastali
│  ├─ geocoder.js             Nominatim (ricerca, reverse, confini comunali) + Photon (suggerimenti)
│  ├─ ui.js                   componenti UI: pannelli, tooltip, toast, scheda, stampa
│  └─ api.js                  client del backend (sessione, CSRF, visura)
├─ data/comuni.json           7.904 Comuni ISTAT con codice catastale, provincia e regione
├─ vendor/ol/                 OpenLayers 10.10 (build completa, locale: funziona anche offline/PWA)
├─ icons/                     icone PWA (rigenerabili con `npm run icons`)
├─ manifest.json, service-worker.js
├─ server/
│  ├─ server.js               Express: sicurezza, proxy, API, statico
│  ├─ config.js               lettura/validazione variabili d'ambiente
│  ├─ routes/proxy.js         proxy OGC controllato con cache LRU
│  ├─ routes/auth.js          login/logout/profilo
│  ├─ routes/catasto.js       /api/catasto/identify, /parcel, /visura, stato servizi
│  ├─ services/cadastralProvider.js  provider server (AdE) + provider intestatari (none/mock/http)
│  ├─ middleware/auth.js      sessioni firmate HMAC, CSRF, ruoli, scrypt
│  ├─ middleware/audit.js     audit log JSON Lines e access log
│  ├─ middleware/validate.js  validazione parametri catastali
│  └─ cloudflare-worker.js    proxy alternativo per hosting statico
├─ tools/make-icons.js, tools/hash-password.js
├─ .env.example
└─ README.md
```

## Configurazione

### Frontend: `js/config.js`

| Chiave | Significato |
|---|---|
| `BACKEND_API_URL` | `''` = stessa origine del server Node; altrimenti l'URL del backend (richiede `CORS_ORIGINS` lato server). |
| `CATASTO_WMS_URL` / `CATASTO_WFS_URL` | endpoint usati dal browser. Default: proxy `/proxy/wms/catasto`, `/proxy/wfs/catasto`. Per il Worker: `https://<worker>.workers.dev/wms/catasto`. |
| `CATASTO_WMS_UPSTREAM` / `CATASTO_WFS_UPSTREAM` | endpoint ufficiali AdE (informativi: il proxy li legge da `.env`). |
| `CATASTO_WMS_GROUPS` | livelli WMS reali (da GetCapabilities) raggruppati per scala di visibilità. |
| `IDENTIFY_MODE` | `auto` (WFS con fallback su GetFeatureInfo), `wfs`, `wms`. |
| `GEOCODER_URL` | Nominatim (ricerca completa e reverse). |
| `GEOCODER_SUGGEST_URL` | Photon per i suggerimenti in digitazione; `''` per disattivarli. |
| `BASEMAPS`, `EXTRA_LAYERS` | basemap XYZ/OSM e livelli WMS aggiuntivi (ortofoto PCN, CTR/ortofoto FVG). |
| `HOVER` | debounce (ms), zoom minimo per interrogare, dimensione cache geometrie, raggio della finestra WFS. |
| `CROSSHAIR_SETTLE_MS` | attesa dopo il trascinamento su smartphone prima di identificare il punto centrale. |

### Backend: `.env`

Copiare `.env.example` in `.env`. Le variabili principali:

| Variabile | Note |
|---|---|
| `NODE_ENV` | `development` o `production`. In produzione `SESSION_SECRET` è obbligatorio e il mock è disattivato. |
| `PORT`, `HOST` | porta/indirizzo di ascolto. |
| `SESSION_SECRET` | ≥ 32 caratteri: `npm run hash-password -- --secret`. |
| `BEHIND_PROXY`, `COOKIE_SECURE` | `true` dietro reverse proxy HTTPS. |
| `CORS_ORIGINS` | origini ammesse se il frontend è su un altro dominio. |
| `USERS_JSON` | utenti OPERATOR/ADMIN con hash scrypt (vedi sotto). |
| `CATASTO_WMS_URL`, `CATASTO_WFS_URL` | endpoint ufficiali proxati. |
| `PCN_WMS_URL` | ortofoto Geoportale Nazionale (solo http → proxata). Vuoto = disattivata. |
| `EXTRA_WMS_PROXIES` | JSON `{"id":"url"}` per proxare altri WMS. |
| `UPSTREAM_USER_AGENT` | identificazione verso i servizi esterni (Nominatim la richiede). |
| `OWNERSHIP_PROVIDER` | `none` (default), `mock` (solo sviluppo), `http` (servizio autorizzato). |
| `OWNERSHIP_API_URL`, `OWNERSHIP_API_TOKEN` | credenziali del servizio autorizzato (mai nel frontend). |
| `REQUIRE_MOTIVO` | richiede il motivo della consultazione prima dei dati personali. |
| `AUDIT_LOG`, `ACCESS_LOG` | percorsi dei log. |

### WMS/WFS catastale

Endpoint ufficiali (documentati dal Geoportale Cartografico Catastale dell'Agenzia delle Entrate, verificati con GetCapabilities):

- WMS 1.3.0: `https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php`
  layer: `CP.CadastralZoning` (fogli), `CP.CadastralParcel` (particelle), `fabbricati`, `acque`, `strade`, `vestizioni`, `codice_plla` (numeri di particella), `simbolo_graffa`, `province`
  CRS: EPSG:4258, 6706, 3044-3046, 25832-25834 (**non** EPSG:3857 → OpenLayers riproietta le tile)
  GetFeatureInfo: `text/html` (l'unico formato che restituisce foglio e particella)
- WFS 2.0: `https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php`
  feature type: `CP:CadastralParcel`, `CP:CadastralZoning`; solo `GetFeature` per `BBOX` (vedi limitazioni)

Per cambiare endpoint (es. mirror interno dell'ente) modificare `.env` (proxy) e, se il servizio invia CORS, direttamente `CATASTO_WMS_URL`/`CATASTO_WFS_URL` in `config.js`.

### Geocoder

- **Nominatim** (`https://nominatim.openstreetmap.org`): ricerca completa al submit, reverse geocoding, confine del Comune (per minimappa e bbox dei fogli). Politica d'uso rispettata: massimo 1 richiesta al secondo (coda nel client), niente autocomplete, `Referer`/`User-Agent` identificativi. Per volumi elevati installare un'istanza propria e cambiare `GEOCODER_URL`.
- **Photon** (`https://photon.komoot.io/api/`): suggerimenti durante la digitazione (consentiti), con debounce di 320 ms.

### API visure e intestatari

Endpoint del backend (profilo OPERATOR/ADMIN, sessione autenticata, rate limit):

```
GET /api/catasto/visura?codiceComune=H609&sezione=&foglio=12&particella=200&subalterno=&motivo=istruttoria%20pratica%20123
```

Risposta:

```json
{
  "status": "ok",
  "fonte": "…",
  "dataVisura": "2026-09-08",
  "immobile": {},
  "intestatari": [ { "nome": "", "cognome": "", "titolarita": "", "quota": "" } ]
}
```

Se nessun servizio è configurato risponde `501 { "status": "not_configured", "message": "Visura catastale non configurata…" }` e il frontend mostra:

> Dati cartografici individuati correttamente. Per conoscere gli intestatari catastali è necessario effettuare una consultazione/visura attraverso un servizio autorizzato.

Collegamento a un servizio autorizzato (`OWNERSHIP_PROVIDER=http`): il backend chiama `OWNERSHIP_API_URL` con `Authorization: Bearer OWNERSHIP_API_TOKEN` e gli stessi parametri, e si aspetta la risposta nel formato sopra. È il punto in cui inserire l'integrazione con **SISTER**, con i servizi di interoperabilità dell'Agenzia delle Entrate riservati agli enti convenzionati o con un intermediario abilitato: sono servizi che richiedono convenzione e credenziali dell'ente, che restano esclusivamente sul server. Non esiste un'API pubblica per gli intestatari e questo software non tenta di ottenerli in altro modo.

Ogni consultazione (riuscita, fallita o non configurata) viene registrata in `server/logs/audit.log` con utente, ruolo, IP, data/ora, motivo, Comune, sezione, foglio, particella, subalterno, esito.

### Utenti e ruoli

| Ruolo | Permessi |
|---|---|
| `PUBLIC` | mappa, ricerca indirizzo, foglio/particella, coordinate, ricerca catastale, stampa. Nessun dato personale. |
| `OPERATOR` | come PUBLIC + richiesta visura tramite backend (con motivo). |
| `ADMIN` | come OPERATOR (riservato a estensioni: gestione utenti, consultazione log). |

Creare un utente:

```bash
npm run hash-password -- "password-robusta"
```

e inserire l'hash in `.env`:

```
USERS_JSON=[{"username":"operatore","role":"OPERATOR","passwordHash":"scrypt$…$…"}]
```

Le password sono conservate con scrypt e confrontate in tempo costante; il login è limitato a 10 tentativi per 15 minuti per IP.

## Pubblicazione

### A. Server Node (consigliato: proxy + visure)

1. `NODE_ENV=production`, `SESSION_SECRET`, `BEHIND_PROXY=true`, `COOKIE_SECURE=true` in `.env`.
2. Reverse proxy HTTPS (Caddy, nginx, Cloudflare Tunnel) davanti a `127.0.0.1:8080`.
   Esempio Caddy: `catasto.example.org { reverse_proxy 127.0.0.1:8080 }`
3. Avvio con `npm start` sotto un supervisore (systemd, pm2, Docker).
4. Il service worker e l'installazione PWA richiedono HTTPS.

### B. Hosting statico (GitHub Pages, Netlify, Cloudflare Pages) + Worker

Il frontend è statico: caricare la cartella (senza `server/`, `tools/`, `node_modules/`). Per GetFeatureInfo/WFS serve un proxy: pubblicare `server/cloudflare-worker.js`

```bash
npx wrangler deploy server/cloudflare-worker.js --name catasto-map-proxy
```

e impostare in `config.js` la costante `CATASTO_WORKER` (il file sceglie da solo il proxy Node quando gira su localhost e il Worker altrove):

```js
const CATASTO_WORKER = 'https://catasto-map-proxy.<account>.workers.dev';
```

Deploy usato per costalonga.org:

```bash
npx wrangler deploy server/cloudflare-worker.js --name catasto-map-proxy --compatibility-date 2026-09-01 --var "ALLOWED_ORIGINS:https://costalonga.org,https://guidocostalonga.github.io"
```

In questa modalità login e visure non sono disponibili (profilo PUBBLICO) a meno di pubblicare anche il backend Node e impostare `BACKEND_API_URL` + `CORS_ORIGINS`.

### Aggiornamenti PWA

Cambiare `CACHE_VERSION` in `service-worker.js` a ogni rilascio.

## Funzioni

- **Ricerca rapida** nella barra: riconosce automaticamente un indirizzo («via Dante 4 Roveredo in Piano») o una query catastale («Roveredo in Piano foglio 12 particella 200», anche con `fg`, `part.`, `mappale`, `sez.`, `sub`).
- **Indirizzo trovato**: volo sulla mappa, marker animato, attivazione della cartografia catastale, identificazione della particella in corrispondenza dell'indirizzo, scheda con INDIRIZZO TROVATO + DATI CATASTALI.
- **Hover**: tooltip con Comune, sezione, foglio, particella; contorno azzurro della particella. Le geometrie ricevute dal WFS restano in cache: muovendosi dentro particelle già note non parte nessuna richiesta. Debounce 250 ms, `AbortController`, cache dei punti senza particella.
- **Clic**: poligono in primo piano, maschera scura sull'intorno, fit sul mappale, animazione pulse 700 ms, numero particella al centro, pin sul punto cliccato, apertura scheda.
- **🎯 Punta e scopri**: cursore a mirino e HUD in tempo reale; il clic blocca la selezione.
- **Mirino centrale (smartphone)**: reticolo fisso, identificazione automatica 400 ms dopo la fine del trascinamento, pulsante SELEZIONA QUESTA PARTICELLA.
- **Scheda**: Comune, codice catastale, provincia, regione, sezione, foglio (con allegato/sviluppo), particella, subalterno, coordinate, superficie geometrica (indicativa), campi censuari dichiarati non disponibili; pulsanti Copia dati / Copia coordinate / Google Maps / Centra / Scheda PDF / Richiedi visura.
- **Strumenti**: GPS, misura distanza e superficie, stampa mappa, link condivisibile, scheda PDF (via stampa del browser → "Salva come PDF"), cambio basemap, punti utente, coordinate decimali/DMS, cronologia (localStorage), pulizia.
- **Livelli**: basemap OSM / HOT / satellite Esri / nessuna; gruppi catastali (fogli, particelle+fabbricati, numeri) con opacità e legenda ufficiale; ortofoto PCN (via proxy); CTR e ortofoto Regione FVG come esempio di livelli regionali; confine comunale dal geocoder.
- **URL condivisibile**: `/?comune=Roveredo%20in%20Piano&cod=H609&foglio=12&particella=200` (anche `comune=RoveredoInPiano`), oppure `/?lat=…&lon=…&z=18&sel=1`.
- **Minimappa** con confine del Comune e posizione dell'area selezionata.
- **PWA** installabile (iPhone, iPad, Android, Windows, macOS): app shell in cache, tile di base in cache limitata, API e servizi OGC sempre da rete.

## Sicurezza

- Nessun segreto nel frontend: token, credenziali e URL dei servizi autorizzati sono solo in `.env`.
- `helmet` con Content-Security-Policy restrittiva (`script-src 'self'`, `frame-ancestors 'none'`), HSTS in HTTPS.
- CORS chiuso per default; aperto solo alle origini in `CORS_ORIGINS`.
- Rate limiting su API, proxy, login e visure.
- Sessione in cookie **HttpOnly, SameSite=Strict, Secure** firmato HMAC-SHA256; rotazione al login; scadenza configurabile.
- Protezione CSRF (double submit: header `X-CSRF-Token` deve coincidere con il token di sessione) su tutte le richieste non sicure.
- Validazione rigorosa dei parametri (codice Belfiore, foglio, particella anche non intera come `12/3`, subalterno, motivo, coordinate).
- Proxy OGC con whitelist di `REQUEST` e parametri, limite di dimensione immagine e di area BBOX, nessun inoltro di cookie.
- Audit log delle consultazioni di dati personali e degli accessi; access log delle API; errori restituiti senza stack trace.
- Protezione XSS: tutto il contenuto dinamico è inserito con escape (`ui.js`), nessun `innerHTML` con dati esterni non filtrati.

## Privacy

- La modalità pubblica non mostra mai dati personali: i servizi cartografici AdE non li contengono.
- Gli intestatari sono accessibili solo a profili autenticati, tramite servizio autorizzato, con motivo obbligatorio e registrazione della consultazione (base giuridica e conservazione dei log da definire nel registro dei trattamenti dell'ente).
- Geocoder esterni (OSM Nominatim, Photon): ricevono le stringhe cercate e le coordinate. Per esigenze di riservatezza usare un'istanza propria.
- La cronologia delle particelle è salvata solo nel browser (localStorage).

## Limitazioni dei servizi ufficiali (verificate)

Verifiche effettuate con GetCapabilities e richieste reali l'8 settembre 2026:

1. **GetFeatureInfo restituisce attributi solo in `text/html`**: con `text/plain` e `application/vnd.ogc.gml` la risposta contiene solo il rettangolo (`boundedBy`). Il parser legge la tabella HTML (`NationalCadastralReference`, `Label`, `InspireId`).
2. **Il WFS accetta solo `GetFeature` per BBOX** (`TYPENAMES` + `BBOX`, opzionali `COUNT`/`STARTINDEX`). I filtri FES per attributo, `RESOURCEID` e le stored query rispondono «Richiesta non valida». La ricerca inversa è quindi realizzata in due passi: bbox del Comune (da OSM) → `CP:CadastralZoning` → bbox del foglio → `CP:CadastralParcel` → filtro sul riferimento. Il primo caricamento di un foglio scarica tutte le sue particelle (tipicamente 0,5-3 MB, alcuni secondi); i risultati sono poi in cache (browser e proxy).
3. **Nessun header CORS** sui servizi AdE: serve il proxy.
4. **Nessun dato censuario** (superficie catastale, qualità, classe, redditi) né intestatari: sono disponibili solo tramite visura. La superficie mostrata è calcolata dalla geometria WFS ed è indicativa.
5. **Scale di visibilità del WMS**: particelle e fabbricati fino a 1:5000 (zoom ≥ ~16), numeri di particella fino a 1:2000 (zoom ≥ ~17.5), fogli fino a 1:200000. Sotto queste scale l'app avvisa «Zoomare maggiormente per interrogare il catasto».
6. **Sezioni, allegati e sviluppi**: il riferimento nazionale è `CCCC[S]_FFFFAS.PPPP` (Comune, sezione opzionale, foglio a 4 cifre, allegato, sviluppo, particella); l'app li gestisce e accetta particelle non intere (`12/3`, `ACQUA001`, suffissi alfabetici) tipiche del catasto tavolare e delle aree particolari.
7. **Latenza e stabilità del server AdE**: il WMS risponde di norma in meno di un secondo ma restituisce errori 500 sporadici sotto carico; il WFS oscilla da meno di un secondo a oltre 40 secondi per lo stesso foglio. L'app reagisce con ritentativi (proxy: 2, client: 4 con attese crescenti), limitando a 6 le connessioni contemporanee per host, mostrando lo stato di avanzamento e mettendo in cache ogni risposta utile.
8. **Ortofoto Geoportale Nazionale**: il servizio risponde solo in http (redirect da https): viene proxato. All'8 settembre 2026 il GetMap delle ortofoto 2012 restituisce un errore interno di MapServer (file tile non accessibili lato server): il livello resta configurato ma può risultare vuoto finché il Ministero non ripristina il servizio. I livelli regionali FVG rispondono in EPSG:900913 con CORS assente: sono mostrati come immagini ma esclusi dallo snapshot di stampa.

## Architettura a provider

```js
class CadastralProvider {
  identifyPoint(lat, lon, opts)                 // particella nel punto (+ geometria se disponibile)
  findParcel(comune, foglio, particella, opts)  // ricerca inversa
  getParcelGeometry(ref, hint, opts)            // geometria GeoJSON
  getParcelInfo(parcel)                         // dati descrittivi disponibili
  getOwnershipInfo(parcel, opts)                // intestatari: solo via backend autorizzato
  checkServices()
}
```

Implementazioni: `AgenziaEntrateMapProvider` (browser e server), `MockOwnershipProvider` (solo sviluppo), `ExternalHttpOwnershipProvider` (server, servizio autorizzato). Per aggiungere un provider (es. un WFS regionale con filtri per attributo) basta implementare l'interfaccia e istanziarla in `app.js`.

## Licenze e attribuzioni

- Cartografia catastale: © Agenzia delle Entrate, CC BY 4.0 — la citazione della titolarità è obbligatoria (presente in mappa, scheda e stampa).
- Basemap: © OpenStreetMap contributors (ODbL); tile HOT © Humanitarian OSM Team; satellite © Esri e partner (uso soggetto ai termini Esri).
- Elenco Comuni: ISTAT, tramite il dataset `matteocontrini/comuni-json` (MIT).
- OpenLayers: BSD 2-Clause.
- Codice dell'applicazione: MIT — @ginopizza.

I dati mostrati non hanno valore legale: per usi ufficiali richiedere visura ed estratto di mappa all'Agenzia delle Entrate.
