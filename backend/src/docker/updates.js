// Procedura di update (pull + recreate) con clone integrale, journal SQLite,
// rollback automatico, gestione dipendenti net=container: (pattern VPN),
// self-update via helper effimero, scheduler check con jitter.
import pLimit from 'p-limit';
import { db } from '../core/db.js';
import { config } from '../core/config.js';
import { docker, features, selfId, withLock, HELPER_LABEL } from './manager.js';
import { checkImageUpdate, cacheUpdateResult, authConfigFor, invalidateUpdateCache, allCachedResults } from './registry.js';
import { notify } from '../core/notify.js';
import { audit } from '../core/audit.js';
import { log, sleep } from '../core/util.js';

let ioRef = null;
export function bindUpdatesIo(io) { ioRef = io; }

function emitProgress(id, payload) {
  ioRef?.to(`update:${id.slice(0, 12)}`).emit('update:progress', { id: id.slice(0, 12), ...payload });
}

// ---- Journal ----
function journalOpen(containerId, name, payload) {
  const info = db.prepare(`INSERT INTO update_journal (container_id, name, old_id, phase, payload, started_at)
                           VALUES (?, ?, ?, 'pull', ?, ?)`)
    .run(containerId, name, containerId, JSON.stringify(payload), Date.now());
  return info.lastInsertRowid;
}
function journalUpdate(jid, fields) {
  const row = db.prepare('SELECT payload FROM update_journal WHERE id = ?').get(jid);
  const payload = { ...(row ? JSON.parse(row.payload) : {}), ...(fields.payload || {}) };
  db.prepare('UPDATE update_journal SET phase = COALESCE(?, phase), new_id = COALESCE(?, new_id), payload = ? WHERE id = ?')
    .run(fields.phase || null, fields.newId || null, JSON.stringify(payload), jid);
}
function journalClose(jid, phase) {
  db.prepare('UPDATE update_journal SET phase = ?, finished_at = ? WHERE id = ?').run(phase, Date.now(), jid);
}

// ---- Dipendenti NetworkMode=container:<target> ----
export async function findDependents(targetId) {
  const all = await docker.listContainers({ all: true });
  const target = await docker.getContainer(targetId).inspect();
  const tName = target.Name.replace(/^\//, '');
  const out = [];
  for (const c of all) {
    if (c.Labels?.[HELPER_LABEL]) continue;
    const nm = c.HostConfig?.NetworkMode || '';
    if (!nm.startsWith('container:')) continue;
    const refTarget = nm.slice('container:'.length);
    const byName = refTarget === tName;
    const byId = target.Id.startsWith(refTarget) || refTarget === target.Id;
    if (byName || byId) {
      out.push({ id: c.Id, name: (c.Names?.[0] || '').replace(/^\//, ''), byName, running: c.State === 'running' });
    }
  }
  return out;
}

// ---- Clone create-config da un inspect ----
// Clone integrale di Config + HostConfig (nessuna whitelist), sostituendo solo Image.
function buildCloneSpec(info, newImageRef) {
  const cfg = structuredClone(info.Config);
  cfg.Image = newImageRef;
  // Hostname = short-id del vecchio container ⇒ è il default generato, non va congelato.
  if (cfg.Hostname === info.Id.slice(0, 12)) cfg.Hostname = '';
  const hostConfig = structuredClone(info.HostConfig);

  // Endpoint di rete: preserva IP statici, MAC e aliases (br0/macvlan/ipvlan).
  const shortId = info.Id.slice(0, 12);
  const endpoints = {};
  const nm = hostConfig.NetworkMode || 'default';
  const attachable = !['host', 'none'].includes(nm) && !nm.startsWith('container:');
  if (attachable) {
    for (const [netName, ep] of Object.entries(info.NetworkSettings?.Networks || {})) {
      endpoints[netName] = {
        IPAMConfig: ep.IPAMConfig && (ep.IPAMConfig.IPv4Address || ep.IPAMConfig.IPv6Address)
          ? { IPv4Address: ep.IPAMConfig.IPv4Address || undefined, IPv6Address: ep.IPAMConfig.IPv6Address || undefined }
          : undefined,
        Aliases: (ep.Aliases || []).filter(a => a !== shortId),
        MacAddress: ep.MacAddress || undefined,
        Links: ep.Links || undefined,
      };
    }
  }
  return { cfg, hostConfig, endpoints };
}

// Crea il container gestendo la limitazione "una sola rete nel create":
// con API ≥1.44 passa tutti gli endpoint, altrimenti prima rete nel create
// e `network connect` per le altre PRIMA dello start.
async function createWithNetworks(name, cfg, hostConfig, endpoints) {
  const netNames = Object.keys(endpoints);
  let createEndpoints = {};
  let pending = [];
  if (netNames.length > 0) {
    if (features.createMultiEndpoint) {
      createEndpoints = endpoints;
    } else {
      // Preferisci la rete indicata da NetworkMode, altrimenti la prima
      const first = netNames.includes(hostConfig.NetworkMode) ? hostConfig.NetworkMode : netNames[0];
      createEndpoints = { [first]: endpoints[first] };
      pending = netNames.filter(n => n !== first);
    }
  }
  const created = await docker.createContainer({
    ...cfg,
    name,
    HostConfig: hostConfig,
    NetworkingConfig: netNames.length ? { EndpointsConfig: createEndpoints } : undefined,
  });
  for (const netName of pending) {
    await docker.getNetwork(netName).connect({ Container: created.id, EndpointConfig: endpoints[netName] });
  }
  return created;
}

// ---- Pull con progresso ----
async function pullImage(ref, containerId) {
  const authconfig = authConfigFor(ref);
  const stream = await docker.pull(ref, authconfig ? { authconfig } : {});
  let lastEmit = 0;
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream,
      (err) => err ? reject(err) : resolve(),
      (ev) => {
        const now = Date.now();
        if (now - lastEmit > 200) {
          lastEmit = now;
          emitProgress(containerId, { phase: 'pull', status: ev.status, layer: ev.id, progress: ev.progressDetail });
        }
      });
  });
}

// ---- Verifica healthcheck-aware ----
async function verifyContainer(newId) {
  const info = await docker.getContainer(newId).inspect();
  const hc = info.Config?.Healthcheck;
  const hasHealth = hc && Array.isArray(hc.Test) && hc.Test.length > 0 && hc.Test[0] !== 'NONE';

  if (hasHealth) {
    const startPeriodMs = (hc.StartPeriod || 0) / 1e6; // ns → ms
    const timeout = config.updateVerifyTimeout ?? Math.min(startPeriodMs + 30000, 120000);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const cur = await docker.getContainer(newId).inspect();
      const st = cur.State?.Health?.Status;
      if (!cur.State?.Running) throw new Error('il nuovo container si è fermato durante la verifica');
      if (st === 'healthy') return;
      if (st === 'unhealthy') throw new Error('healthcheck: unhealthy');
      await sleep(2000);
    }
    throw new Error(`healthcheck non healthy entro ${Math.round((config.updateVerifyTimeout ?? Math.min(startPeriodMs + 30000, 120000)) / 1000)}s`);
  } else {
    // Senza healthcheck: running stabile per 10s (override UPDATE_VERIFY_TIMEOUT)
    const stableMs = config.updateVerifyTimeout ?? 10000;
    const before = await docker.getContainer(newId).inspect();
    await sleep(stableMs);
    const after = await docker.getContainer(newId).inspect();
    if (!after.State?.Running) throw new Error(`il container non è rimasto in esecuzione per ${Math.round(stableMs / 1000)}s`);
    if (after.RestartCount > before.RestartCount) throw new Error('il container è stato riavviato durante la verifica');
  }
}

// ---- Procedura completa di update ----
// opts: { removeOldImage = true, allowSelf = false (solo updater helper) }
export async function updateContainer(id, opts = {}, user = 'sistema') {
  const { removeOldImage = true, allowSelf = false } = opts;
  const target = await docker.getContainer(id).inspect();
  const name = target.Name.replace(/^\//, '');

  // Self-update: il container non può ricrearsi da solo → helper effimero.
  if (selfId && target.Id === selfId && !allowSelf) {
    return spawnSelfUpdateHelper(user);
  }

  return withLock(target.Id, 'update', async () => {
    const ref = target.Config.Image;
    if (/^(sha256:)?[0-9a-f]{64}$/.test(ref)) {
      throw new Error('Container creato da id immagine (senza tag): update non applicabile');
    }
    const dependents = await findDependents(target.Id);
    const wasRunning = Boolean(target.State?.Running);
    const oldImageId = target.Image;
    const renamedName = `${name}-old-${Date.now()}`;

    // Journal aperto PRIMA del rename: gli update interrotti vengono recuperati all'avvio.
    const jid = journalOpen(target.Id, name, {
      ref, oldName: name, renamedName, wasRunning, removeOldImage, oldImageId,
      dependents: dependents.map(d => ({ id: d.id, name: d.name, byName: d.byName, running: d.running })),
    });

    try {
      // 1. Pull
      emitProgress(target.Id, { phase: 'pull', status: 'Pull immagine…' });
      await pullImage(ref, target.Id);
      const newImage = await docker.getImage(ref).inspect();
      if (newImage.Id === oldImageId) {
        journalClose(jid, 'done');
        emitProgress(target.Id, { phase: 'done', status: 'Già aggiornato' });
        invalidateUpdateCache(ref);
        cacheUpdateResult(ref, { status: 'current', localDigest: (newImage.RepoDigests?.[0] || '').split('@')[1] });
        audit(user, 'container.update', name, 'ok', null, 'già aggiornato');
        return { status: 'uptodate' };
      }

      // 2-3. Clone integrale Config+HostConfig + reti
      const { cfg, hostConfig, endpoints } = buildCloneSpec(target, ref);

      // 4. Stop → rename → create (stesso nome: l'autostart di dockerman è per nome) → start → verifica
      emitProgress(target.Id, { phase: 'stop', status: 'Stop container…' });
      journalUpdate(jid, { phase: 'stop' });
      if (wasRunning) {
        await docker.getContainer(target.Id).stop().catch(e => { if (e.statusCode !== 304) throw e; });
      }
      journalUpdate(jid, { phase: 'rename' });
      await docker.getContainer(target.Id).rename({ name: renamedName });

      let newId = null;
      try {
        emitProgress(target.Id, { phase: 'create', status: 'Ricreazione container…' });
        const created = await createWithNetworks(name, cfg, hostConfig, endpoints);
        newId = created.id;
        journalUpdate(jid, { phase: 'start', newId });

        emitProgress(target.Id, { phase: 'start', status: 'Avvio…' });
        await created.start();

        emitProgress(target.Id, { phase: 'verify', status: 'Verifica post-update…' });
        journalUpdate(jid, { phase: 'verify' });
        await verifyContainer(newId);
      } catch (err) {
        // Rollback automatico
        log.warn(`[update] ${name}: fallito (${err.message}), rollback…`);
        emitProgress(target.Id, { phase: 'rollback', status: `Errore: ${err.message} — rollback…` });
        if (newId) await docker.getContainer(newId).remove({ force: true }).catch(() => {});
        await docker.getContainer(target.Id).rename({ name }).catch(() => {});
        if (wasRunning) await docker.getContainer(target.Id).start().catch(() => {});
        journalClose(jid, 'rolledback');
        audit(user, 'container.update', name, 'errore', null, `rollback: ${err.message}`);
        throw new Error(`Update fallito, rollback eseguito: ${err.message}`);
      }

      // 5. Dipendenti net=container: ricreati (riferimento per id) o riavviati (per nome)
      journalUpdate(jid, { phase: 'dependents' });
      const depResults = [];
      for (const dep of dependents) {
        try {
          emitProgress(target.Id, { phase: 'dependents', status: `Aggiornamento dipendente ${dep.name}…` });
          if (dep.byName) {
            // Il netns deve ri-agganciarsi al nuovo container: restart sufficiente (risoluzione per nome)
            if (dep.running) await docker.getContainer(dep.id).restart();
          } else {
            await recreateDependent(dep.id, newId);
          }
          depResults.push({ name: dep.name, ok: true });
        } catch (e) {
          depResults.push({ name: dep.name, ok: false, error: e.message });
          log.warn(`[update] dipendente ${dep.name} fallito:`, e.message);
        }
      }

      // 6. Cleanup: rimozione vecchio container + vecchia immagine dangling (default on)
      emitProgress(target.Id, { phase: 'cleanup', status: 'Pulizia…' });
      journalUpdate(jid, { phase: 'cleanup' });
      await docker.getContainer(target.Id).remove({ force: true }).catch(e => log.warn('[update] rimozione old fallita:', e.message));
      if (removeOldImage) {
        await docker.getImage(oldImageId).remove().catch(() => { /* ancora in uso o taggata: ok */ });
      }

      journalClose(jid, 'done');
      invalidateUpdateCache(ref);
      cacheUpdateResult(ref, { status: 'current', localDigest: (newImage.RepoDigests?.[0] || '').split('@')[1] });
      emitProgress(target.Id, { phase: 'done', status: 'Update completato', newId });
      audit(user, 'container.update', name, 'ok', null, `nuova immagine ${newImage.Id.slice(7, 19)}`);
      return { status: 'updated', newId, dependents: depResults };
    } catch (err) {
      // Errori in fase pull/clone (prima del rename): journal chiuso come fallito
      const row = db.prepare('SELECT phase, finished_at FROM update_journal WHERE id = ?').get(jid);
      if (row && !row.finished_at) journalClose(jid, 'failed');
      emitProgress(target.Id, { phase: 'error', status: err.message });
      throw err;
    }
  });
}

// Ricrea un dipendente puntando il netns al nuovo id del target.
async function recreateDependent(depId, newTargetId) {
  const info = await docker.getContainer(depId).inspect();
  const name = info.Name.replace(/^\//, '');
  return withLock(depId, 'update-dipendente', async () => {
    const { cfg, hostConfig, endpoints } = buildCloneSpec(info, info.Config.Image);
    hostConfig.NetworkMode = `container:${newTargetId}`;
    const wasRunning = Boolean(info.State?.Running);
    if (wasRunning) await docker.getContainer(depId).stop().catch(() => {});
    await docker.getContainer(depId).rename({ name: `${name}-old-${Date.now()}` });
    try {
      const created = await createWithNetworks(name, cfg, hostConfig, endpoints);
      if (wasRunning) await created.start();
      await docker.getContainer(depId).remove({ force: true }).catch(() => {});
    } catch (e) {
      await docker.getContainer(depId).rename({ name }).catch(() => {});
      if (wasRunning) await docker.getContainer(depId).start().catch(() => {});
      throw e;
    }
  });
}

// ---- Self-update: helper effimero ----
export async function spawnSelfUpdateHelper(user) {
  const self = await docker.getContainer(selfId).inspect();
  const binds = [];
  for (const m of self.Mounts || []) {
    if (m.Destination === '/var/run/docker.sock' || m.Destination === '/config') {
      binds.push(`${m.Source}:${m.Destination}${m.RW ? '' : ':ro'}`);
    }
  }
  if (!binds.some(b => b.includes('docker.sock'))) binds.push('/var/run/docker.sock:/var/run/docker.sock');

  const helper = await docker.createContainer({
    name: `unraiddeck-updater-${Date.now()}`,
    Image: self.Image, // pin per id: nessuna race sulla risoluzione del tag
    Cmd: ['node', 'backend/src/updater.js', selfId],
    Env: self.Config.Env,
    Labels: { [HELPER_LABEL]: '1' },
    HostConfig: { Binds: binds, AutoRemove: true, NetworkMode: 'bridge' },
  });
  await helper.start();
  audit(user, 'container.self-update', 'unraiddeck', 'ok', null, `helper ${helper.id.slice(0, 12)} avviato`);
  log.info(`[update] helper self-update avviato: ${helper.id.slice(0, 12)}`);
  return { status: 'helper-started', helperId: helper.id };
}

// ---- Recovery all'avvio: update interrotti da crash/riavvio ----
export async function recoverJournal() {
  const open = db.prepare('SELECT * FROM update_journal WHERE finished_at IS NULL').all();
  for (const row of open) {
    const payload = JSON.parse(row.payload || '{}');
    log.warn(`[update] recovery journal #${row.id} (${row.name}, fase ${row.phase})`);
    try {
      const newOk = row.new_id ? await docker.getContainer(row.new_id).inspect().catch(() => null) : null;
      if (newOk?.State?.Running) {
        // Il nuovo gira: completa (rimuovi il vecchio rinominato)
        const old = await docker.getContainer(row.old_id).inspect().catch(() => null);
        if (old && old.Name.replace(/^\//, '') === payload.renamedName) {
          await docker.getContainer(row.old_id).remove({ force: true }).catch(() => {});
        }
        journalClose(row.id, 'done');
        log.info(`[update] recovery #${row.id}: completato`);
      } else {
        // Rollback: rimuovi il nuovo (se esiste), ripristina il vecchio
        if (newOk) await docker.getContainer(row.new_id).remove({ force: true }).catch(() => {});
        const old = await docker.getContainer(row.old_id).inspect().catch(() => null);
        if (old) {
          if (old.Name.replace(/^\//, '') === payload.renamedName) {
            await docker.getContainer(row.old_id).rename({ name: payload.oldName }).catch(() => {});
          }
          if (payload.wasRunning && !old.State?.Running) {
            await docker.getContainer(row.old_id).start().catch(() => {});
          }
        }
        journalClose(row.id, 'rolledback');
        log.info(`[update] recovery #${row.id}: rollback`);
      }
    } catch (e) {
      journalClose(row.id, 'failed');
      log.error(`[update] recovery #${row.id} fallita:`, e.message);
    }
  }
  // Residui -old-<ts> orfani riferiti da journal conclusi
  const doneRows = db.prepare("SELECT old_id, payload FROM update_journal WHERE phase = 'done'").all();
  for (const r of doneRows) {
    const payload = JSON.parse(r.payload || '{}');
    const c = await docker.getContainer(r.old_id).inspect().catch(() => null);
    if (c && c.Name.replace(/^\//, '') === payload.renamedName) {
      log.warn(`[update] rimozione residuo orfano ${payload.renamedName}`);
      await docker.getContainer(r.old_id).remove({ force: true }).catch(() => {});
    }
  }
}

// ---- Check aggiornamenti: scheduler con jitter + manuale ----
let checkTimer = null;
export async function checkAllUpdates(user = 'scheduler') {
  const containers = await docker.listContainers({ all: true });
  const visible = containers.filter(c => !c.Labels?.[HELPER_LABEL]);
  let updates = 0;
  const results = {};
  await Promise.all(visible.map(async (c) => {
    try {
      const imageInspect = await docker.getImage(c.ImageID).inspect().catch(() => null);
      const res = await checkImageUpdate(c.Image, imageInspect);
      cacheUpdateResult(c.Image, res);
      results[c.Image] = { status: res.status, reason: res.reason, checkedAt: Date.now() };
      if (res.status === 'update') updates += 1;
    } catch (e) {
      results[c.Image] = { status: 'error', reason: e.message, checkedAt: Date.now() };
    }
  }));
  ioRef?.to('events').emit('updates:status', results);
  if (updates > 0) {
    notify('updates-available', 'info', `${updates} aggiornament${updates === 1 ? 'o' : 'i'} disponibil${updates === 1 ? 'e' : 'i'}`,
      'Controlla la lista container per i dettagli.');
  }
  audit(user, 'updates.check', 'globale', 'ok', null, `${updates} update disponibili`);
  return results;
}

export async function checkOneUpdate(id) {
  const c = await docker.getContainer(id).inspect();
  const imageInspect = await docker.getImage(c.Image).inspect().catch(() => null);
  const res = await checkImageUpdate(c.Config.Image, imageInspect);
  cacheUpdateResult(c.Config.Image, res);
  ioRef?.to('events').emit('updates:status', { [c.Config.Image]: { status: res.status, reason: res.reason, checkedAt: Date.now() } });
  return res;
}

export function scheduleUpdateChecks() {
  const plan = () => {
    const jitter = 0.9 + Math.random() * 0.2; // ±10%
    const delay = Math.round(config.updateCheckInterval * jitter);
    checkTimer = setTimeout(async () => {
      try { await checkAllUpdates(); } catch (e) { log.warn('[update] check periodico fallito:', e.message); }
      plan();
    }, delay);
    checkTimer.unref?.();
  };
  // Primo check 60s dopo l'avvio
  setTimeout(() => { checkAllUpdates().catch(e => log.warn('[update] primo check fallito:', e.message)); }, 60000).unref();
  plan();
}
export function stopUpdateChecks() {
  if (checkTimer) clearTimeout(checkTimer);
}

export { allCachedResults };
