// Stats real-time: NIENTE stream persistenti per-container. Batch one-shot
// (API ≥1.41, altrimenti stream=false a campione singolo), p-limit(8),
// attivo solo con ≥1 client nella room. Intervallo adattivo 2s/5s.
// Ring buffer 120 punti in RAM, broadcast coalescato.
import pLimit from 'p-limit';
import { docker, features } from './manager.js';
import { log } from '../core/util.js';

const RING_SIZE = 120;
const limit = pLimit(8);

let ioRef = null;
let timer = null;
let running = false;
const fastSockets = new Set();      // socket che chiedono cadenza 2s (drawer aperto)
const prev = new Map();             // id -> campione precedente per delta CPU/rete/IO
const rings = new Map();            // id -> [{ts, cpu, mem, memLimit, rx, tx}...]

export function initStatsHub(io) {
  ioRef = io;
  const room = () => io.sockets.adapter.rooms.get('stats');
  io.on('connection', (socket) => {
    socket.on('stats:fast', (fast) => {
      if (fast) fastSockets.add(socket.id); else fastSockets.delete(socket.id);
      reschedule();
    });
    socket.on('disconnect', () => { fastSockets.delete(socket.id); reschedule(); });
  });
  // Ricontrolla la membership della room a ogni join/leave
  io.of('/').adapter.on('join-room', (r) => { if (r === 'stats') reschedule(); });
  io.of('/').adapter.on('leave-room', (r) => { if (r === 'stats') reschedule(); });

  function reschedule() {
    const members = room()?.size || 0;
    const wantedInterval = fastSockets.size > 0 ? 2000 : 5000;
    if (members > 0 && !running) start(wantedInterval);
    else if (members === 0 && running) stop();
    else if (running && wantedInterval !== currentInterval) start(wantedInterval);
  }
}

let currentInterval = 5000;
function start(intervalMs) {
  stop();
  running = true;
  currentInterval = intervalMs;
  timer = setInterval(tick, intervalMs);
  tick();
}
function stop() {
  running = false;
  if (timer) { clearInterval(timer); timer = null; }
}
export function stopStatsHub() { stop(); }

async function tick() {
  try {
    const containers = await docker.listContainers(); // solo running
    const results = await Promise.all(containers.map(c => limit(() => sample(c.Id))));
    const batch = results.filter(Boolean);
    if (batch.length) ioRef?.to('stats').emit('stats:batch', batch);
  } catch (e) {
    log.warn('[stats] tick fallito:', e.message);
  }
}

async function sample(id) {
  try {
    // one-shot non include precpu → delta calcolato dal campione precedente in RAM
    const opts = features.statsOneShot ? { stream: false, 'one-shot': true } : { stream: false };
    const s = await docker.getContainer(id).stats(opts);
    const now = Date.now();

    const cpuTotal = s.cpu_stats?.cpu_usage?.total_usage || 0;
    const sysTotal = s.cpu_stats?.system_cpu_usage || 0;
    const onlineCpus = s.cpu_stats?.online_cpus || (s.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1);

    // RAM: usage − inactive_file (cgroup v2) oppure − total_inactive_file (v1); MAI assumere `cache`.
    const memStats = s.memory_stats?.stats || {};
    const inactive = memStats.inactive_file ?? memStats.total_inactive_file ?? 0;
    const memUsed = Math.max(0, (s.memory_stats?.usage || 0) - inactive);
    const memLimit = s.memory_stats?.limit || 0;

    let rx = 0, tx = 0;
    for (const nw of Object.values(s.networks || {})) { rx += nw.rx_bytes || 0; tx += nw.tx_bytes || 0; }

    const p = prev.get(id);
    let cpu = 0, rxRate = 0, txRate = 0;
    if (p && sysTotal > p.sysTotal) {
      const cpuDelta = cpuTotal - p.cpuTotal;
      const sysDelta = sysTotal - p.sysTotal;
      cpu = (cpuDelta / sysDelta) * onlineCpus * 100;
      const dt = (now - p.ts) / 1000;
      if (dt > 0) { rxRate = Math.max(0, (rx - p.rx) / dt); txRate = Math.max(0, (tx - p.tx) / dt); }
    }
    prev.set(id, { cpuTotal, sysTotal, rx, tx, ts: now });

    const point = { id, ts: now, cpu: Math.round(cpu * 10) / 10, mem: memUsed, memLimit, rx: Math.round(rxRate), tx: Math.round(txRate) };
    let ring = rings.get(id);
    if (!ring) { ring = []; rings.set(id, ring); }
    ring.push(point);
    if (ring.length > RING_SIZE) ring.shift();
    return point;
  } catch {
    return null; // container appena fermato / rimosso
  }
}

// Storico per il grafico esteso nel drawer.
export function statsHistory(id) {
  return rings.get(id) || [];
}

// Pulizia buffer quando un container viene distrutto.
export function dropStats(id) {
  for (const key of rings.keys()) if (key.startsWith(id)) rings.delete(key);
  for (const key of prev.keys()) if (key.startsWith(id)) prev.delete(key);
}
