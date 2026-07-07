// Orchestrazione dati Unraid: GraphQL primario (7.x) con capability map,
// fallback SSH (6.12). Poll per-sezione con intervalli dedicati, degradazione
// PER-SEZIONE (non per-tab), broadcast diff su socket.io room "unraid",
// allarmi con isteresi (temp dischi) e notifiche.
import { config } from '../core/config.js';
import * as gql from './graphql.js';
import * as ssh from './ssh-fallback.js';
import { upsStatus } from './ups.js';
import { recordPowerSample } from './energy.js';
import { notify, alarmActive, alarmClear, tempThreshold } from '../core/notify.js';
import { log } from '../core/util.js';
import WebSocket from 'ws';

let ioRef = null;
let timers = [];
let notifWs = null;
let stopped = false;

export const unraidState = {
  mode: 'none',            // 'graphql' | 'ssh' | 'none'
  caps: null,
  sections: {},            // system | array | disks | pools | shares | vms | ups
  errors: {},              // per-sezione: messaggio errore
  updatedAt: {},
  lastError: null,         // ultimo errore di connessione GraphQL (per la UI)
};

function setSection(name, data, error = null) {
  const payload = JSON.stringify({ data, error });
  const prev = unraidState._prev?.[name];
  unraidState.sections[name] = data;
  unraidState.errors[name] = error;
  unraidState.updatedAt[name] = Date.now();
  unraidState._prev = unraidState._prev || {};
  if (prev !== payload) {
    unraidState._prev[name] = payload;
    ioRef?.to('unraid').emit('unraid:section', { section: name, data, error, mode: unraidState.mode });
  }
}

export function snapshot() {
  return {
    mode: unraidState.mode,
    caps: unraidState.caps ? Object.fromEntries(Object.entries(unraidState.caps).filter(([k]) => !k.startsWith('_'))) : null,
    sections: unraidState.sections,
    errors: unraidState.errors,
    updatedAt: unraidState.updatedAt,
    configured: Boolean(config.unraidHost || config.unraidUrl),
    apiKeyConfigured: Boolean(config.unraidApiKey),
    sshConfigured: ssh.sshConfigured(),
    lastError: unraidState.lastError,
  };
}

// ---- Normalizzazioni (DTO comuni GraphQL/SSH) ----
const kb = (v) => (Number(v) || 0) * 1024;

function normDiskG(d) {
  return {
    idx: d.idx ?? null, name: d.name, device: d.device || null,
    size: kb(d.size), temp: d.temp ?? null,
    spunDown: d.temp === null || d.temp === undefined,
    numErrors: Number(d.numErrors) || 0,
    fsType: d.fsType || null, fsSize: kb(d.fsSize), fsFree: kb(d.fsFree), fsUsed: kb(d.fsUsed),
    status: d.status || null, type: d.type || null, color: d.color || null,
  };
}

async function pollArrayGraphql() {
  const a = await gql.queryArray();
  let parity = null;
  if (unraidState.caps?._queryFields?.vars) {
    try {
      const data = await gql.gqlRequest(`query { vars { mdResync mdResyncPos mdResyncSize mdResyncCorr mdResyncAction sbSyncErrs mdState } }`);
      const v = data.vars || {};
      const active = Number(v.mdResync) > 0;
      const size = Number(v.mdResyncSize) || 0;
      const pos = Number(v.mdResyncPos) || 0;
      parity = {
        running: active, pos, size,
        pct: active && size > 0 ? Math.round((pos / size) * 10000) / 100 : null,
        correcting: String(v.mdResyncCorr) === '1',
        action: v.mdResyncAction || null,
        errors: Number(v.sbSyncErrs) || 0,
      };
    } catch { /* vars non disponibile */ }
  }
  const capKb = a.capacity?.kilobytes;
  return {
    state: (a.state || 'UNKNOWN').toUpperCase(),
    capacity: capKb ? { total: kb(capKb.total), used: kb(capKb.used), free: kb(capKb.free) } : null,
    parities: (a.parities || []).map(normDiskG),
    disks: (a.disks || []).map(normDiskG),
    caches: (a.caches || []).map(normDiskG),
    parity,
  };
}

async function pollArraySsh() {
  const [arr, disks] = await Promise.all([ssh.sshArray(), ssh.sshDisks()]);
  const byType = (t) => disks.filter(d => (d.type || '').toLowerCase() === t);
  const dataDisks = byType('data');
  const tot = dataDisks.reduce((a, d) => a + d.fsSize, 0);
  const free = dataDisks.reduce((a, d) => a + d.fsFree, 0);
  return {
    state: arr.state,
    capacity: tot ? { total: tot, used: tot - free, free } : null,
    parities: byType('parity'),
    disks: dataDisks,
    caches: byType('cache'),
    parity: arr.parity,
  };
}

async function pollSystemGraphql() {
  const info = await gql.queryInfo();
  let cpuPct = null, mem = null;
  if (unraidState.caps?._queryFields?.metrics) {
    try {
      const data = await gql.gqlRequest(`query { metrics { cpu { percentTotal } memory { total used free available } } }`);
      cpuPct = data.metrics?.cpu?.percentTotal ?? null;
      const mm = data.metrics?.memory;
      if (mm) mem = { total: Number(mm.total) || 0, used: Number(mm.used) || 0, free: Number(mm.free) || 0, available: Number(mm.available) || 0 };
    } catch { /* metrics non disponibile */ }
  }
  if (!mem && info.memory) {
    mem = {
      total: Number(info.memory.total) || 0, used: Number(info.memory.used) || 0,
      free: Number(info.memory.free) || 0, available: Number(info.memory.available) || 0,
    };
  }
  let uptimeSec = null;
  const up = info.os?.uptime;
  if (up != null) {
    uptimeSec = /^\d+(\.\d+)?$/.test(String(up)) ? Number(up) : Math.max(0, (Date.now() - Date.parse(up)) / 1000);
  }
  return {
    cpuPct: cpuPct != null ? Math.round(cpuPct * 10) / 10 : null,
    load: null,
    memTotal: mem?.total || 0, memUsed: mem?.used || 0, memFree: mem?.free || 0, memAvailable: mem?.available || 0,
    uptimeSec,
    temps: {},
    os: info.os ? `${info.os.distro || 'Unraid'} ${info.os.release || ''}`.trim() : null,
    cpu: info.cpu ? `${info.cpu.brand || ''} (${info.cpu.cores || '?'} core)`.trim() : null,
    unraidVersion: info.versions?.unraid || null,
  };
}

function normVm(v) {
  return { name: v.name, uuid: v.uuid || null, state: String(v.state || 'unknown').toLowerCase().replace('_', '-') };
}

// ---- Allarmi ----
function checkDiskAlarms(disks) {
  const th = tempThreshold();
  for (const d of disks || []) {
    if (d.temp == null) continue;
    const key = `disk-temp:${d.name}`;
    if (d.temp >= th) {
      if (!alarmActive(key)) notify(key, 'warning', `Disco ${d.name} a ${d.temp}°C`, `Soglia ${th}°C superata (${d.device || ''})`);
    } else if (d.temp <= th - 3 && alarmActive(key)) {
      alarmClear(key); // isteresi: rientro a soglia−3°C
    }
  }
}
let prevParityRunning = false;
function checkParityAlarms(parity) {
  if (!parity) return;
  if (prevParityRunning && !parity.running && (parity.errors || 0) > 0) {
    notify('parity-errors', 'error', 'Parity check terminato con errori', `${parity.errors} errori di sync`);
  }
  prevParityRunning = Boolean(parity.running);
}
function checkPoolAlarms(pools) {
  for (const p of pools || []) {
    const key = `pool-degraded:${p.name}`;
    const bad = p.degraded || !['OK', 'ONLINE'].includes(String(p.health || '').toUpperCase());
    if (bad) {
      if (!alarmActive(key)) notify(key, 'error', `Pool ${p.name} degradato`, `Stato: ${p.health}${p.errors ? `, ${p.errors} errori device` : ''}`);
    } else if (alarmActive(key)) {
      alarmClear(key);
    }
  }
}
function checkUpsAlarms(ups) {
  const key = 'ups-onbatt';
  if (ups?.onBattery) {
    if (!alarmActive(key)) notify(key, 'error', 'UPS su batteria', `Carica ${ups.chargePct ?? '?'}%, autonomia ${ups.runtimeMin ?? '?'} min`);
  } else if (ups && alarmActive(key)) {
    alarmClear(key);
  }
}

// ---- Poll runner con gestione errori per-sezione ----
function runSection(name, fn, intervalMs) {
  const tick = async () => {
    if (stopped) return;
    try {
      const data = await fn();
      setSection(name, data, null);
    } catch (e) {
      setSection(name, unraidState.sections[name] ?? null, e.message);
    }
  };
  tick();
  const t = setInterval(tick, intervalMs);
  t.unref?.();
  timers.push(t);
}

// ---- Init/route dei due backend ----
export async function initUnraid(io) {
  ioRef = io;
  stopped = false;
  if (!config.unraidHost && !config.unraidUrl) {
    unraidState.mode = 'none';
    log.warn('[unraid] UNRAID_HOST non configurato: tab Unraid disabilitata');
    return;
  }
  await chooseMode();
  startPolling();
  // Se in fallback/none ma il GraphQL è configurato, riprova l'upgrade ogni 5 min
  const t = setInterval(async () => {
    if (stopped || unraidState.mode === 'graphql' || !config.unraidApiKey) return;
    const prev = unraidState.mode;
    await chooseMode(true);
    if (unraidState.mode !== prev) {
      log.info(`[unraid] modalità cambiata: ${prev} → ${unraidState.mode}`);
      restartPolling();
    }
  }, 5 * 60000);
  t.unref?.();
  timers.push(t);
}

async function chooseMode(quiet = false) {
  if (config.unraidApiKey) {
    try {
      unraidState.caps = await gql.introspect();
      unraidState.mode = 'graphql';
      unraidState.lastError = null;
      startNotificationSub();
      return;
    } catch (e) {
      unraidState.lastError = e.message;
      if (!quiet) log.warn(`[unraid] GraphQL non raggiungibile (${e.message})${ssh.sshConfigured() ? ', fallback SSH' : ''}`);
    }
  } else if (config.unraidHost || config.unraidUrl) {
    unraidState.lastError = 'UNRAID_API_KEY non impostata';
  }
  if (ssh.sshConfigured()) {
    unraidState.mode = 'ssh';
  } else {
    unraidState.mode = 'none';
    if (!quiet) log.warn('[unraid] né GraphQL né SSH configurati/raggiungibili');
  }
}

function startPolling() {
  const g = unraidState.mode === 'graphql';
  const s = unraidState.mode === 'ssh';
  if (!g && !s) return;
  const caps = unraidState.caps;

  // Sistema (5s)
  if (g && caps.info) runSection('system', pollSystemGraphql, config.pollSystem);
  else if (s) runSection('system', ssh.sshSystem, config.pollSystem);

  // Array + parity (30s) — con allarmi parity
  const arrayFn = g && caps.array ? pollArrayGraphql : (s ? pollArraySsh : null);
  if (arrayFn) {
    runSection('array', async () => {
      const a = await arrayFn();
      checkParityAlarms(a.parity);
      return a;
    }, config.pollArray);
  } else if (g) {
    setSection('array', null, 'query "array" non esposta dallo schema GraphQL');
  }

  // Dischi (60s) — temperatura/spin SEMPRE da fonte passiva; allarmi temp
  runSection('disks', async () => {
    let disks;
    if (g && caps.array) {
      const a = unraidState.sections.array || await arrayFn();
      disks = [...(a.parities || []), ...(a.disks || []), ...(a.caches || [])];
    } else if (s) {
      disks = await ssh.sshDisks();
    } else {
      throw new Error('nessuna fonte dischi disponibile');
    }
    checkDiskAlarms(disks);
    return disks;
  }, config.pollDisks);

  // Pool (300s) — GraphQL se esposto, altrimenti SSH
  if (g && caps.pools) {
    runSection('pools', async () => {
      const pools = (await gql.queryPools() || []).map(p => ({
        name: p.name, type: p.fsType || null,
        health: p.health || p.status || p.state || 'OK',
        degraded: !['OK', 'ONLINE', 'HEALTHY'].includes(String(p.health || p.status || p.state || 'OK').toUpperCase()),
        size: Number(p.size) || null, used: Number(p.used) || null, free: Number(p.free) || null,
      }));
      checkPoolAlarms(pools);
      return pools;
    }, config.pollShares);
  } else if (ssh.sshConfigured()) {
    runSection('pools', async () => {
      const pools = await ssh.sshPools();
      checkPoolAlarms(pools);
      return pools;
    }, config.pollShares);
  } else if (g) {
    setSection('pools', null, 'pools non esposto dallo schema e SSH non configurato');
  }

  // Shares (300s)
  if (g && caps.shares) {
    runSection('shares', async () => (await gql.queryShares() || []).map(sh => ({
      name: sh.name, free: kb(sh.free), size: kb(sh.size),
      used: sh.used != null ? kb(sh.used) : (sh.size != null && sh.free != null ? kb(sh.size) - kb(sh.free) : null),
      cache: sh.cache ?? null, comment: sh.comment || '',
    })), config.pollShares);
  } else if (s) {
    runSection('shares', ssh.sshShares, config.pollShares);
  }

  // VM (60s)
  if (g && caps.vms) {
    runSection('vms', async () => (await gql.queryVms()).map(normVm), 60000);
  } else if (s) {
    runSection('vms', async () => (await ssh.sshVms()).map(normVm), 60000);
  }

  // UPS (10s, near-real-time) — TCP diretto, nessun mount necessario
  runSection('ups', async () => {
    const ups = await upsStatus();
    checkUpsAlarms(ups);
    recordPowerSample(ups?.watts ?? null);
    return ups;
  }, config.pollUps);
}

function restartPolling() {
  for (const t of timers) clearInterval(t);
  timers = [];
  startPolling();
}

export function stopUnraid() {
  stopped = true;
  for (const t of timers) clearInterval(t);
  timers = [];
  try { notifWs?.close(); } catch { /* ignora */ }
  ssh.sshClose();
}

// ---- Azioni (mode-aware) ----
export async function arrayAction(action) {
  if (unraidState.mode === 'graphql' && unraidState.caps?.arrayMutations) {
    return gql.mutateArrayState(action === 'start' ? 'START' : 'STOP');
  }
  if (ssh.sshConfigured()) return ssh.sshArrayAction(action);
  throw new Error('nessun canale disponibile per il controllo array');
}
export async function parityAction(action, correct) {
  if (unraidState.mode === 'graphql' && unraidState.caps?.parityMutations) {
    return gql.mutateParity(action, correct);
  }
  if (ssh.sshConfigured()) return ssh.sshParityAction(action, correct);
  throw new Error('nessun canale disponibile per il parity check');
}
export async function vmAction(key, action) {
  const vms = unraidState.sections.vms || [];
  const vm = vms.find(v => v.uuid === key || v.name === key);
  if (unraidState.mode === 'graphql' && unraidState.caps?.vmMutations && vm?.uuid) {
    return gql.mutateVm(action, vm.uuid);
  }
  if (ssh.sshConfigured()) return ssh.sshVmAction(vm?.name || key, action);
  throw new Error('nessun canale disponibile per le VM');
}
// Power host: mutation reboot/shutdown se esposte, altrimenti powerdown via SSH.
export async function powerAction(action) {
  if (unraidState.mode === 'graphql' && unraidState.caps?.[action]) {
    return gql.mutatePower(action);
  }
  if (ssh.sshConfigured()) return ssh.sshPower(action);
  throw new Error('nessun canale disponibile per il power host');
}
export async function parityHistory() {
  if (unraidState.mode === 'graphql' && unraidState.caps?._queryFields?.parityHistory) {
    try {
      const data = await gql.gqlRequest(`query { parityHistory { date duration speed status errors } }`);
      return (data.parityHistory || []).map(p => ({
        date: p.date, durationSec: Number(p.duration) || null, speed: p.speed || null,
        errors: p.errors != null ? Number(p.errors) : null, action: p.status || null,
      })).reverse();
    } catch { /* fallback ssh sotto */ }
  }
  if (ssh.sshConfigured()) return ssh.sshParityHistory();
  throw new Error('storico parity non disponibile (richiede GraphQL parityHistory o SSH)');
}
export async function smartReport(device) {
  if (!ssh.sshConfigured()) throw new Error('SMART on-demand richiede il fallback SSH configurato');
  return ssh.sshSmart(device);
}

// ---- Subscription notifiche (graphql-transport-ws), se disponibile ----
function startNotificationSub() {
  if (!unraidState.caps?.notificationsSub || notifWs) return;
  const url = (config.unraidUrl || '').replace(/^http/, 'ws').replace(/\/$/, '') + '/graphql';
  try {
    const wsOpts = { headers: { 'x-api-key': config.unraidApiKey }, rejectUnauthorized: !config.unraidTlsInsecure };
    const sock = new WebSocket(url, 'graphql-transport-ws', wsOpts);
    notifWs = sock;
    sock.on('open', () => {
      sock.send(JSON.stringify({ type: 'connection_init', payload: { 'x-api-key': config.unraidApiKey } }));
    });
    sock.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'connection_ack') {
          const fields = gql.presentFields('Notification', ['id', 'title', 'subject', 'description', 'importance']).join(' ') || 'id title';
          sock.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: `subscription { notificationAdded { ${fields} } }` } }));
        } else if (msg.type === 'next') {
          const n = msg.payload?.data?.notificationAdded;
          if (n) {
            const sev = { ALERT: 'error', WARNING: 'warning', INFO: 'info' }[String(n.importance || 'INFO').toUpperCase()] || 'info';
            notify(`unraid:${n.id || n.title}`, sev, n.title || n.subject || 'Notifica Unraid', n.description || n.subject || '');
          }
        }
      } catch { /* messaggio non valido */ }
    });
    const retry = () => {
      notifWs = null;
      if (!stopped && unraidState.mode === 'graphql') setTimeout(startNotificationSub, 30000).unref?.();
    };
    sock.on('close', retry);
    sock.on('error', () => { try { sock.close(); } catch { /* ignora */ } });
  } catch (e) {
    log.warn('[unraid] subscription notifiche non attivabile:', e.message);
    notifWs = null;
  }
}
