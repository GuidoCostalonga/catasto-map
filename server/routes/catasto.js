/**
 * catasto.js — API catastali del backend.
 *
 *  GET /api/catasto/identify?lat&lon            (pubblica) particella nel punto — dati cartografici, nessun dato personale
 *  GET /api/catasto/parcel?codiceComune&foglio&particella  (pubblica) geometria della particella
 *  GET /api/catasto/visura?codiceComune&sezione&foglio&particella&subalterno&motivo
 *      (OPERATOR/ADMIN) intestatari tramite servizio AUTORIZZATO; ogni consultazione è registrata nell'audit log.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { requireRole } from '../middleware/auth.js';
import { auditOwnershipAccess } from '../middleware/audit.js';
import { validateCadastral, validateLatLon } from '../middleware/validate.js';
import { AgenziaEntrateMapProvider, createOwnershipProvider, NotConfiguredError } from '../services/cadastralProvider.js';

const router = Router();
const mapProvider = new AgenziaEntrateMapProvider();
const ownership = createOwnershipProvider();

router.get('/identify', async (req, res, next) => {
  try {
    const { lat, lon } = validateLatLon(req.query);
    const parcel = await mapProvider.identifyPoint(lat, lon, { geometry: req.query.geometry === '1' });
    if (!parcel) return res.json({ status: 'empty', message: 'Nessuna particella catastale in questo punto.' });
    res.json({ status: 'ok', fonte: 'Agenzia delle Entrate – WMS/WFS cartografia catastale (CC BY 4.0)', parcel });
  } catch (err) { next(err); }
});

router.get('/parcel', async (req, res, next) => {
  try {
    const q = validateCadastral(req.query);
    const parcel = await mapProvider.findParcel(q.codiceComune, q.foglio, q.particella, { sezione: q.sezione });
    res.json({ status: 'ok', fonte: 'Agenzia delle Entrate – WFS cartografia catastale (CC BY 4.0)', parcel });
  } catch (err) { next(err); }
});

router.get('/visura', requireRole('OPERATOR', 'ADMIN'), async (req, res, next) => {
  const user = req.user;
  let q;
  try {
    q = validateCadastral(req.query);
  } catch (err) { return next(err); }
  if (config.requireMotivo && !q.motivo) {
    return res.status(400).json({ code: 'MOTIVO_REQUIRED', message: 'Indicare il motivo della consultazione.' });
  }
  const base = { user: user.username, role: user.role, ip: req.ip, motivo: q.motivo || null, codiceComune: q.codiceComune, sezione: q.sezione || null, foglio: q.foglio, particella: q.particella, subalterno: q.subalterno || null, provider: ownership.name };
  try {
    const result = await ownership.getOwnershipInfo(q);
    auditOwnershipAccess({ ...base, esito: 'OK', intestatari: (result.intestatari || []).length });
    res.json({ status: 'ok', fonte: result.fonte, dataVisura: result.dataVisura, demo: !!result.demo, immobile: result.immobile || {}, intestatari: result.intestatari || [] });
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      auditOwnershipAccess({ ...base, esito: 'NOT_CONFIGURED' });
      return res.status(501).json({ status: 'not_configured', code: 'NOT_CONFIGURED', message: 'Visura catastale non configurata. Collegare il backend a un servizio catastale autorizzato (vedi README).' });
    }
    auditOwnershipAccess({ ...base, esito: 'ERROR', errore: err.code || err.message });
    next(err);
  }
});

/** Stato dei servizi per il pannello amministratore (senza dettagli sensibili). */
let statusCache = { t: 0, data: null };
export async function servicesStatus() {
  if (statusCache.data && Date.now() - statusCache.t < 60000) return statusCache.data;
  const check = async (url, name) => {
    try {
      const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': config.userAgent } });
      return { name, ok: r.ok, status: r.status };
    } catch (e) { return { name, ok: false, error: e.name === 'TimeoutError' ? 'timeout' : 'errore di rete' }; }
  };
  const [wms, wfs] = await Promise.all([
    check(`${config.catastoWmsUrl}?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0`, 'WMS AdE'),
    check(`${config.catastoWfsUrl}?SERVICE=WFS&REQUEST=GetCapabilities&VERSION=2.0.0`, 'WFS AdE')
  ]);
  const { proxyIds } = await import('./proxy.js');
  const data = {
    env: config.env,
    upstream: { wms, wfs },
    proxies: proxyIds,
    visure: { configured: ownership.configured, provider: ownership.name, demo: ownership.name === 'mock', note: ownership.note },
    auth: { users: config.users.length, requireMotivo: config.requireMotivo }
  };
  statusCache = { t: Date.now(), data };
  return data;
}

export default router;
