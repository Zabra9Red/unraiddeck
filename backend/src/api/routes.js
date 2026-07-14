// Route REST. Tutte le route (tranne /health e le route di auth) richiedono
// sessione valida; le mutanti passano anche dal check Origin/Sec-Fetch-Site.
// Conferma digitata (nome risorsa) per: remove container, kill, stop array,
// reboot/shutdown host; rafforzata per stop/remove di UnraidDeck stesso.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import pLimit from 'p-limit';
import { config } from '../core/config.js';
import { getSetting, setSetting, fuseWarning, db } from '../core/db.js';
import { encrypt } from '../core/crypto.js';
import * as auth from '../core/auth.js';
import { audit, auditList } from '../core/audit.js';
import { notifList, notifMarkRead, notify } from '../core/notify.js';
import * as manager from '../docker/manager.js';
import { streamLogsDownload } from '../docker/logs.js';
import { statsHistory } from '../docker/stats-hub.js';
import { serveIcon } from '../docker/icons.js';
import { updateContainer, findDependents, checkAllUpdates, checkOneUpdate, allCachedResults, autoUpdateConfig, setAutoUpdateConfig } from '../docker/updates.js';
import * as poller from '../unraid/poller.js';
import { energyOverview, energyBreakdown, getEnergyConfig, setEnergyConfig } from '../unraid/energy.js';
import * as files from '../unraid/files.js';

export function buildRouter() {
  const r = Router();

  // Rate limit azioni: 30/min (login ha il suo limite dedicato con backoff)
  const actionLimiter = rateLimit({
    windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Troppe richieste: attendere un minuto' },
    skip: (req) => req.method === 'GET',
  });

  // ---- Health (ESENTE da auth, richiesto dall'HEALTHCHECK): solo status ----
  r.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // ---- Meta pre-login (minimale) ----
  r.get('/meta', (_req, res) => {
    res.json({
      setupRequired: auth.setupRequired(),
      disableAuth: config.disableAuth,
      version: config.version,
    });
  });

  // ---- Setup wizard (solo primo avvio, quando non esistono utenti) ----
  r.post('/setup', (req, res) => {
    if (!auth.setupRequired()) return res.status(403).json({ error: 'Setup già completato' });
    const { username, password } = req.body || {};
    if (!username || !/^[\w.-]{2,32}$/.test(username)) return res.status(400).json({ error: 'Username non valido (2-32 caratteri alfanumerici)' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password minimo 8 caratteri' });
    const id = auth.createUser(username, password);
    const token = auth.createSession({ id }, req);
    auth.setSessionCookie(req, res, token);
    audit(username, 'auth.setup', username, 'ok', req.ip);
    res.json({ ok: true, user: { id, username } });
  });

  // ---- Login / logout / sessioni ----
  r.post('/login', (req, res) => {
    const rl = auth.loginRateCheck(req.ip);
    if (!rl.ok) return res.status(429).json({ error: `Troppi tentativi: riprova tra ${rl.retryAfter}s`, retryAfter: rl.retryAfter });
    const { username, password, totp } = req.body || {};
    const out = auth.login(String(username || ''), String(password || ''), totp, req);
    if (!out.ok) {
      if (out.reason === 'totp_required') return res.status(401).json({ error: 'Codice TOTP richiesto', totpRequired: true });
      auth.loginRateFail(req.ip);
      audit(username, 'auth.login', null, 'fallito', req.ip, out.reason);
      return res.status(401).json({ error: out.reason === 'totp_invalid' ? 'Codice TOTP non valido' : 'Credenziali non valide' });
    }
    auth.loginRateReset(req.ip);
    auth.setSessionCookie(req, res, out.token);
    audit(out.user.username, 'auth.login', null, 'ok', req.ip);
    res.json({ ok: true, user: out.user });
  });

  r.post('/logout', auth.requireAuth, (req, res) => {
    const token = auth.tokenFromReq(req);
    if (token) auth.destroySession(token);
    auth.clearSessionCookie(res);
    audit(req.user.username, 'auth.logout', null, 'ok', req.ip);
    res.json({ ok: true });
  });
  r.post('/logout-all', auth.requireAuth, (req, res) => {
    auth.destroyAllSessions(req.user.id);
    auth.clearSessionCookie(res);
    audit(req.user.username, 'auth.logout-all', null, 'ok', req.ip);
    res.json({ ok: true });
  });
  r.get('/me', auth.requireAuth, (req, res) => {
    res.json({
      user: req.user,
      flags: {
        disableAuth: config.disableAuth,
        fuseWarning,
        passwordEnvWarning: auth.passwordEnvWarning(),
        unraidConfigured: Boolean(config.unraidHost || config.unraidUrl),
      },
      version: config.version,
    });
  });
  r.get('/sessions', auth.requireAuth, (req, res) => {
    res.json(auth.listSessions(req.user.id, auth.tokenFromReq(req)));
  });
  r.delete('/sessions/:prefix', auth.requireAuth, actionLimiter, (req, res) => {
    const ok = auth.destroySessionByPrefix(req.user.id, req.params.prefix);
    res.json({ ok });
  });

  // ---- TOTP ----
  r.post('/totp/setup', auth.requireAuth, actionLimiter, (req, res) => {
    if (config.disableAuth) return res.status(400).json({ error: 'Auth disabilitata' });
    res.json(auth.totpSetup(req.user.id));
  });
  r.post('/totp/enable', auth.requireAuth, actionLimiter, (req, res) => {
    const out = auth.totpEnable(req.user.id, String(req.body?.code || ''));
    if (!out.ok) return res.status(400).json({ error: out.reason });
    audit(req.user.username, 'auth.totp-enable', null, 'ok', req.ip);
    res.json(out);
  });
  r.post('/totp/disable', auth.requireAuth, actionLimiter, (req, res) => {
    const out = auth.totpDisable(req.user.id, String(req.body?.code || ''));
    if (!out.ok) return res.status(400).json({ error: out.reason });
    audit(req.user.username, 'auth.totp-disable', null, 'ok', req.ip);
    res.json(out);
  });
  r.post('/password', auth.requireAuth, actionLimiter, (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Nuova password minimo 8 caratteri' });
    const out = auth.changePassword(req.user.id, String(oldPassword || ''), String(newPassword));
    if (!out.ok) return res.status(400).json({ error: out.reason });
    audit(req.user.username, 'auth.password-change', null, 'ok', req.ip);
    res.json(out);
  });

  // Da qui in giù: tutto autenticato
  r.use(auth.requireAuth);

  // ---- Icone (proxy cacheato) ----
  r.get('/icons', serveIcon);

  // ---- Container ----
  r.get('/containers', async (_req, res, next) => {
    try {
      const list = await manager.listContainers();
      const updates = allCachedResults();
      for (const c of list) c.update = updates[c.image] || null;
      res.json(list);
    } catch (e) { next(e); }
  });

  r.get('/containers/:id', async (req, res, next) => {
    try {
      const info = await manager.docker.getContainer(req.params.id).inspect();
      res.json(info);
    } catch (e) { next(e); }
  });

  r.get('/containers/:id/dependents', async (req, res, next) => {
    try { res.json(await findDependents(req.params.id)); } catch (e) { next(e); }
  });

  r.get('/containers/:id/stats-history', (req, res) => {
    res.json(statsHistory(req.params.id));
  });

  r.get('/containers/:id/logs/download', async (req, res, next) => {
    try { await streamLogsDownload(req.params.id, res, req.query.tail || 'all'); } catch (e) { next(e); }
  });

  // Azione singola. Conferma digitata per remove/kill; rafforzata per il self.
  r.post('/containers/:id/action', actionLimiter, async (req, res, next) => {
    const { action, confirmName } = req.body || {};
    try {
      if (!manager.ACTION_NAMES.includes(action)) return res.status(400).json({ error: 'Azione non valida' });
      const info = await manager.docker.getContainer(req.params.id).inspect();
      const name = info.Name.replace(/^\//, '');
      const isSelf = manager.selfId && info.Id === manager.selfId;

      // Conferma digitata: remove e kill sempre; stop/remove del self rafforzati
      const needsConfirm = ['remove', 'kill'].includes(action) || (isSelf && ['stop', 'remove', 'kill'].includes(action));
      if (needsConfirm && confirmName !== name) {
        return res.status(400).json({ error: `Conferma richiesta: digitare il nome esatto "${name}"`, confirmRequired: true, isSelf });
      }
      await manager.containerAction(info.Id, action);
      audit(req.user.username, `container.${action}`, name, 'ok', req.ip);
      res.json({ ok: true });
    } catch (e) {
      if (e.status === 409) {
        audit(req.user.username, `container.${action}`, req.params.id.slice(0, 12), 'conflitto', req.ip, e.message);
        return res.status(409).json({ error: e.message });
      }
      audit(req.user.username, `container.${action}`, req.params.id.slice(0, 12), 'errore', req.ip, e.message);
      next(e);
    }
  });

  // Update singolo (pull + recreate); self → helper effimero.
  r.post('/containers/:id/update', actionLimiter, async (req, res, next) => {
    try {
      const out = await updateContainer(req.params.id, {
        removeOldImage: req.body?.removeOldImage !== false,
      }, req.user.username);
      res.json(out);
    } catch (e) {
      if (e.status === 409) return res.status(409).json({ error: e.message });
      next(e);
    }
  });

  r.post('/containers/:id/check-update', actionLimiter, async (req, res, next) => {
    try { res.json(await checkOneUpdate(req.params.id)); } catch (e) { next(e); }
  });

  // ---- Bulk: p-limit(3), lock per-container rispettato, self SEMPRE escluso ----
  r.post('/containers/bulk', actionLimiter, async (req, res) => {
    const { ids, action } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids mancanti' });
    if (![...manager.ACTION_NAMES, 'update'].includes(action)) return res.status(400).json({ error: 'Azione non valida' });
    const limit = pLimit(3);
    const results = await Promise.all(ids.map(id => limit(async () => {
      try {
        const info = await manager.docker.getContainer(id).inspect();
        const name = info.Name.replace(/^\//, '');
        if (manager.selfId && info.Id === manager.selfId) {
          return { id, name, ok: false, error: 'UnraidDeck è escluso dalle operazioni bulk' };
        }
        if (['remove', 'kill'].includes(action)) {
          return { id, name, ok: false, error: 'Azione non permessa in bulk' };
        }
        if (action === 'update') await updateContainer(info.Id, {}, req.user.username);
        else await manager.containerAction(info.Id, action);
        return { id, name, ok: true };
      } catch (e) {
        return { id, ok: false, error: e.message };
      }
    })));
    audit(req.user.username, `container.bulk-${action}`, `${ids.length} container`, 'ok', req.ip,
      results.filter(x => !x.ok).map(x => `${x.name || x.id}: ${x.error}`).join('; ') || null);
    res.json(results);
  });

  // ---- Check update globale, prune, system df ----
  r.post('/updates/check', actionLimiter, async (req, res, next) => {
    try { res.json(await checkAllUpdates(req.user.username)); } catch (e) { next(e); }
  });
  r.post('/images/prune', actionLimiter, async (req, res, next) => {
    try {
      const out = await manager.pruneImages();
      audit(req.user.username, 'images.prune', null, 'ok', req.ip, `${out.deleted} immagini, ${out.reclaimed} byte`);
      res.json(out);
    } catch (e) { next(e); }
  });
  r.get('/system/df', async (_req, res, next) => {
    // SOLO on-demand: mai in polling (endpoint lento su host grandi)
    try { res.json(await manager.systemDf()); } catch (e) { next(e); }
  });

  // ---- Unraid ----
  r.get('/unraid/state', (_req, res) => res.json(poller.snapshot()));

  r.post('/unraid/array', actionLimiter, async (req, res, next) => {
    const { action, confirmName } = req.body || {};
    try {
      if (!['start', 'stop'].includes(action)) return res.status(400).json({ error: 'Azione non valida' });
      if (action === 'stop' && confirmName !== 'array') {
        return res.status(400).json({ error: 'Conferma richiesta: digitare "array"', confirmRequired: true });
      }
      await poller.arrayAction(action);
      audit(req.user.username, `unraid.array-${action}`, 'array', 'ok', req.ip);
      res.json({ ok: true });
    } catch (e) {
      audit(req.user.username, `unraid.array-${action}`, 'array', 'errore', req.ip, e.message);
      next(e);
    }
  });

  r.post('/unraid/parity', actionLimiter, async (req, res, next) => {
    const { action, correct } = req.body || {};
    try {
      if (!['start', 'pause', 'resume', 'cancel'].includes(action)) return res.status(400).json({ error: 'Azione non valida' });
      await poller.parityAction(action, Boolean(correct));
      audit(req.user.username, `unraid.parity-${action}`, 'parity', 'ok', req.ip);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.get('/unraid/parity/history', async (_req, res, next) => {
    try { res.json(await poller.parityHistory()); } catch (e) { next(e); }
  });

  // ---- Energia UPS: consumi integrati + costo €/kWh ----
  r.get('/unraid/energy', (req, res, next) => {
    try {
      const out = energyOverview(req.query.hours);
      out.presets = getEnergyConfig().presets;
      res.json(out);
    } catch (e) { next(e); }
  });

  r.get('/unraid/energy/breakdown', (req, res, next) => {
    try { res.json(energyBreakdown(req.query.granularity || 'day', req.query.within || null)); } catch (e) { next(e); }
  });

  // ---- File manager share (SFTP, percorsi confinati sotto /mnt) ----
  r.get('/unraid/files', async (req, res, next) => {
    try {
      const p = files.safePath(req.query.path);
      res.json({ path: p, entries: await files.listDir(p) });
    } catch (e) { next(e); }
  });
  r.get('/unraid/files/download', async (req, res, next) => {
    try {
      const p = files.safePath(req.query.path);
      await files.streamDownload(p, res, req.query.dl === '1');
    } catch (e) { next(e); }
  });
  r.put('/unraid/files/upload', actionLimiter, async (req, res, next) => {
    try {
      const p = files.safePath(req.query.path);
      await files.streamUpload(p, req);
      audit(req.user.username, 'files.upload', p, 'ok', req.ip);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  r.post('/unraid/files/mkdir', actionLimiter, async (req, res, next) => {
    try {
      const p = files.safePath(req.body?.path);
      await files.mkdir(p);
      audit(req.user.username, 'files.mkdir', p, 'ok', req.ip);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  r.post('/unraid/files/rename', actionLimiter, async (req, res, next) => {
    try {
      const from = files.safePath(req.body?.from);
      const to = files.safePath(req.body?.to);
      await files.rename(from, to);
      audit(req.user.username, 'files.rename', `${from} → ${to}`, 'ok', req.ip);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  r.post('/unraid/files/delete', actionLimiter, async (req, res, next) => {
    try {
      const p = files.safePath(req.body?.path);
      await files.remove(p);
      audit(req.user.username, 'files.delete', p, 'ok', req.ip);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---- Auto-update: config on/off + intervallo ore ----
  r.get('/settings/auto-update', (_req, res) => res.json(autoUpdateConfig()));
  r.post('/settings/auto-update', actionLimiter, (req, res, next) => {
    try {
      const cfg = setAutoUpdateConfig(req.body || {});
      audit(req.user.username, 'settings.auto-update', `${cfg.enabled ? 'on' : 'off'} ${cfg.intervalHours}h`, 'ok', req.ip);
      res.json(cfg);
    } catch (e) { next(e); }
  });

  r.post('/unraid/energy/config', actionLimiter, (req, res, next) => {
    try {
      const cfg = setEnergyConfig(req.body || {});
      audit(req.user.username, 'unraid.energy-config', `${cfg.pricePerKwh} €/kWh`, 'ok', req.ip);
      res.json(cfg);
    } catch (e) { next(e); }
  });

  r.get('/unraid/smart/:device', async (req, res, next) => {
    try {
      const out = await poller.smartReport(req.params.device);
      audit(req.user.username, 'unraid.smart', req.params.device, 'ok', req.ip);
      res.json(out);
    } catch (e) { next(e); }
  });

  r.post('/unraid/vms/:key', actionLimiter, async (req, res, next) => {
    const { action } = req.body || {};
    try {
      await poller.vmAction(req.params.key, action);
      audit(req.user.username, `unraid.vm-${action}`, req.params.key, 'ok', req.ip);
      res.json({ ok: true });
    } catch (e) {
      audit(req.user.username, `unraid.vm-${action}`, req.params.key, 'errore', req.ip, e.message);
      next(e);
    }
  });

  // Power host: conferma digitata obbligatoria ("reboot"/"shutdown")
  r.post('/unraid/power', actionLimiter, async (req, res, next) => {
    const { action, confirmName } = req.body || {};
    try {
      if (!['reboot', 'shutdown'].includes(action)) return res.status(400).json({ error: 'Azione non valida' });
      if (confirmName !== action) {
        return res.status(400).json({ error: `Conferma richiesta: digitare "${action}"`, confirmRequired: true });
      }
      await poller.powerAction(action);
      audit(req.user.username, `unraid.power-${action}`, config.unraidHost, 'ok', req.ip);
      res.json({ ok: true });
    } catch (e) {
      audit(req.user.username, `unraid.power-${action}`, config.unraidHost, 'errore', req.ip, e.message);
      next(e);
    }
  });

  // ---- Notifiche ----
  r.get('/notifications', (req, res) => {
    res.json(notifList({ limit: parseInt(req.query.limit || '50', 10), offset: parseInt(req.query.offset || '0', 10) }));
  });
  r.post('/notifications/read', (req, res) => {
    notifMarkRead(req.body?.ids || null);
    res.json({ ok: true });
  });
  r.post('/notify/test', actionLimiter, (req, res) => {
    notify(`test:${Date.now()}`, 'info', 'Notifica di prova', 'Il canale notifiche funziona.');
    res.json({ ok: true });
  });

  // ---- Audit ----
  r.get('/audit', (req, res) => {
    res.json(auditList({
      limit: parseInt(req.query.limit || '100', 10),
      offset: parseInt(req.query.offset || '0', 10),
      action: req.query.action || null,
      user: req.query.user || null,
    }));
  });

  // ---- Impostazioni ----
  r.get('/settings', (_req, res) => {
    const creds = db.prepare('SELECT registry, username FROM registry_creds').all();
    res.json({
      tempThreshold: getSetting('tempThreshold', 45),
      tempMin: getSetting('tempMin', null),
      registryCreds: creds, // password mai esposte
      webhookConfigured: Boolean(config.notifyWebhookUrl),
    });
  });
  r.put('/settings', actionLimiter, (req, res) => {
    const { tempThreshold: th, tempMin } = req.body || {};
    if (th !== undefined) {
      const n = parseInt(th, 10);
      if (!Number.isFinite(n) || n < 20 || n > 80) return res.status(400).json({ error: 'Soglia temperatura 20-80 °C' });
      setSetting('tempThreshold', n);
    }
    if (tempMin !== undefined) {
      if (tempMin === null || tempMin === '') {
        setSetting('tempMin', null);
      } else {
        const n = parseInt(tempMin, 10);
        if (!Number.isFinite(n) || n < 0 || n > 50) return res.status(400).json({ error: 'Soglia minima 0-50 °C (vuota = disattivata)' });
        setSetting('tempMin', n);
      }
    }
    audit(req.user.username, 'settings.update', null, 'ok', req.ip);
    res.json({ ok: true });
  });
  // Credenziali registry (cifrate at-rest), usate per check E pull
  r.post('/settings/registry', actionLimiter, (req, res) => {
    const { registry, username, password } = req.body || {};
    if (!registry || !username || !password) return res.status(400).json({ error: 'registry, username e password richiesti' });
    db.prepare(`INSERT INTO registry_creds (registry, username, password_enc) VALUES (?, ?, ?)
                ON CONFLICT(registry) DO UPDATE SET username = excluded.username, password_enc = excluded.password_enc`)
      .run(String(registry).toLowerCase(), username, encrypt(password));
    audit(req.user.username, 'settings.registry-add', registry, 'ok', req.ip);
    res.json({ ok: true });
  });
  r.delete('/settings/registry/:registry', actionLimiter, (req, res) => {
    db.prepare('DELETE FROM registry_creds WHERE registry = ?').run(req.params.registry.toLowerCase());
    audit(req.user.username, 'settings.registry-del', req.params.registry, 'ok', req.ip);
    res.json({ ok: true });
  });

  return r;
}
