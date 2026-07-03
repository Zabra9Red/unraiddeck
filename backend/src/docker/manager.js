// Gestione Docker via dockerode: negoziazione versione API, cache container
// arricchita (inspect), lock per-container, azioni, rilevamento self, GC helper.
import Docker from 'dockerode';
import fs from 'node:fs';
import os from 'node:os';
import pLimit from 'p-limit';
import { config } from '../core/config.js';
import { log } from '../core/util.js';

export const HELPER_LABEL = 'net.unraiddeck.helper';

export let docker = null;
export let apiVersion = null;        // es. "1.47"
export let features = { statsOneShot: false, createMultiEndpoint: false };
export let selfId = null;            // id completo del container UnraidDeck (null fuori da Docker)

function apiGte(version, target) {
  const [a1, a2] = version.split('.').map(Number);
  const [b1, b2] = target.split('.').map(Number);
  return a1 > b1 || (a1 === b1 && a2 >= b2);
}

export function createDockerClient() {
  if (config.dockerHost) {
    const u = new URL(config.dockerHost.includes('://') ? config.dockerHost : `tcp://${config.dockerHost}`);
    if (u.protocol === 'unix:') return new Docker({ socketPath: u.pathname });
    return new Docker({ host: u.hostname, port: u.port || 2375, protocol: u.protocol.replace(':', '') === 'tcp' ? 'http' : u.protocol.replace(':', '') });
  }
  return new Docker({ socketPath: '/var/run/docker.sock' });
}

// Negoziazione versione API all'avvio (GET /version), loggata.
export async function initDocker() {
  docker = createDockerClient();
  const v = await docker.version();
  apiVersion = v.ApiVersion;
  features.statsOneShot = apiGte(apiVersion, '1.41');
  features.createMultiEndpoint = apiGte(apiVersion, '1.44');
  log.info(`[docker] connesso: ${v.Version} (API ${apiVersion}, one-shot stats: ${features.statsOneShot}, multi-endpoint create: ${features.createMultiEndpoint})`);
  selfId = await detectSelfId();
  if (selfId) log.info(`[docker] self rilevato: ${selfId.slice(0, 12)}`);
  return docker;
}

// Rileva l'id del container in cui giriamo: mountinfo → cgroup → hostname.
async function detectSelfId() {
  const rx = /[0-9a-f]{64}/;
  for (const file of ['/proc/self/mountinfo', '/proc/self/cgroup']) {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      for (const line of txt.split('\n')) {
        if (line.includes('/docker/containers/') || line.includes('/docker/')) {
          const m = line.match(rx);
          if (m) {
            try { await docker.getContainer(m[0]).inspect(); return m[0]; } catch { /* id non valido */ }
          }
        }
      }
    } catch { /* file assente */ }
  }
  // Fallback: hostname come short-id
  const hn = os.hostname();
  if (/^[0-9a-f]{12}$/.test(hn)) {
    try {
      const info = await docker.getContainer(hn).inspect();
      return info.Id;
    } catch { /* non è un id */ }
  }
  return null;
}

// ---- Lock per-container: una sola operazione mutante per id alla volta ----
const locks = new Map(); // id -> descrizione operazione
export class LockedError extends Error {
  constructor(id, op) { super(`Operazione già in corso sul container (${op})`); this.status = 409; this.id = id; }
}
export function acquireLock(id, op) {
  const key = id.slice(0, 12);
  if (locks.has(key)) throw new LockedError(id, locks.get(key));
  locks.set(key, op);
  return () => locks.delete(key);
}
export async function withLock(id, op, fn) {
  const release = acquireLock(id, op);
  try {
    return await fn();
  } finally {
    release();
  }
}
export function lockInfo(id) {
  return locks.get(id.slice(0, 12)) || null;
}

// ---- Cache container (list + inspect arricchito) ----
// La lista Docker non include restart policy / health / startedAt → inspect cache,
// aggiornata dagli eventi (mai polling a regime).
const inspectCache = new Map(); // id -> { restartPolicy, health, startedAt, networkMode, hostname }
const limit = pLimit(8);

export async function refreshInspect(id) {
  try {
    const info = await docker.getContainer(id).inspect();
    inspectCache.set(info.Id, {
      restartPolicy: info.HostConfig?.RestartPolicy?.Name || 'no',
      health: info.State?.Health?.Status || null,
      startedAt: info.State?.Running ? Date.parse(info.State.StartedAt) : null,
      exitCode: info.State?.ExitCode ?? null,
      networkMode: info.HostConfig?.NetworkMode || 'default',
    });
    return info;
  } catch (e) {
    if (e.statusCode === 404) inspectCache.delete(id);
    return null;
  }
}
export function dropInspect(id) {
  for (const key of inspectCache.keys()) if (key.startsWith(id)) inspectCache.delete(key);
}

// Lista container → DTO per la UI. Helper effimeri esclusi.
export async function listContainers() {
  const raw = await docker.listContainers({ all: true });
  const visible = raw.filter(c => !(c.Labels && c.Labels[HELPER_LABEL]));
  // Arricchisci con inspect (solo per id non ancora in cache)
  await Promise.all(visible.filter(c => !inspectCache.has(c.Id)).map(c => limit(() => refreshInspect(c.Id))));
  return visible.map(c => toDto(c));
}

function toDto(c) {
  const extra = inspectCache.get(c.Id) || {};
  const name = (c.Names?.[0] || '').replace(/^\//, '');
  const ports = (c.Ports || []).map(p => ({
    ip: p.IP || null, priv: p.PrivatePort, pub: p.PublicPort || null, type: p.Type,
  }));
  return {
    id: c.Id,
    shortId: c.Id.slice(0, 12),
    name,
    image: c.Image,
    imageId: c.ImageID,
    state: c.State,           // running | exited | paused | ...
    status: c.Status,         // testo "Up 3 hours"
    health: extra.health,
    createdAt: c.Created * 1000,
    startedAt: extra.startedAt || null,
    exitCode: extra.exitCode,
    ports,
    restartPolicy: extra.restartPolicy || null,
    networkMode: extra.networkMode || c.HostConfig?.NetworkMode || null,
    iconUrl: c.Labels?.['net.unraid.docker.icon'] || null,
    webui: resolveWebui(c.Labels?.['net.unraid.docker.webui'], ports),
    isSelf: selfId ? c.Id === selfId : false,
  };
}

// Risolve la label net.unraid.docker.webui: [IP] → host Unraid, [PORT:x] → porta pubblicata.
export function resolveWebui(tpl, ports) {
  if (!tpl) return null;
  let url = tpl;
  url = url.replace(/\[IP\]/g, config.unraidHost || 'localhost');
  url = url.replace(/\[PORT:(\d+)\]/g, (_, p) => {
    const priv = parseInt(p, 10);
    const mapped = ports.find(x => x.priv === priv && x.pub);
    return String(mapped ? mapped.pub : priv);
  });
  return url;
}

// ---- Azioni base ----
const ACTIONS = {
  start: (c) => c.start(),
  stop: (c) => c.stop(),
  restart: (c) => c.restart(),
  pause: (c) => c.pause(),
  unpause: (c) => c.unpause(),
  kill: (c) => c.kill(),
  remove: (c) => c.remove({ force: true }),
};
export const ACTION_NAMES = Object.keys(ACTIONS);

export async function containerAction(id, action) {
  const fn = ACTIONS[action];
  if (!fn) throw new Error(`Azione sconosciuta: ${action}`);
  return withLock(id, action, async () => {
    await fn(docker.getContainer(id));
    if (action === 'remove') dropInspect(id);
    else await refreshInspect(id);
  });
}

// Prune immagini dangling.
export async function pruneImages() {
  const res = await docker.pruneImages({ filters: { dangling: { true: true } } });
  return { deleted: (res.ImagesDeleted || []).length, reclaimed: res.SpaceReclaimed || 0 };
}

// GET /system/df — SOLO on-demand (endpoint lento su host grandi).
export async function systemDf() {
  const d = await docker.df();
  const sum = (arr, f) => (arr || []).reduce((a, x) => a + (f(x) || 0), 0);
  return {
    images: { count: (d.Images || []).length, size: sum(d.Images, x => x.Size), shared: sum(d.Images, x => x.SharedSize) },
    containers: { count: (d.Containers || []).length, size: sum(d.Containers, x => x.SizeRw) },
    volumes: { count: (d.Volumes || []).length, size: sum(d.Volumes, x => x.UsageData?.Size) },
    buildCache: { count: (d.BuildCache || []).length, size: sum(d.BuildCache, x => x.Size) },
  };
}

// GC all'avvio di eventuali helper zombie (label net.unraiddeck.helper=1 non running).
export async function gcHelpers() {
  try {
    const helpers = await docker.listContainers({ all: true, filters: { label: [`${HELPER_LABEL}=1`] } });
    for (const h of helpers) {
      if (h.State !== 'running') {
        log.warn(`[docker] rimozione helper zombie ${h.Id.slice(0, 12)}`);
        await docker.getContainer(h.Id).remove({ force: true }).catch(() => {});
      }
    }
  } catch (e) {
    log.warn('[docker] GC helper fallita:', e.message);
  }
}
