// Fallback SSH per Unraid 6.12: parsing /var/local/emhttp/*.ini, mdcmd solo per
// start/stop/check, zpool/btrfs per i pool, /proc per il sistema, virsh per le VM.
// Connessione persistente con keep-alive e riconnessione con exponential backoff.
import { Client } from 'ssh2';
import fs from 'node:fs';
import { config } from '../core/config.js';
import { log, backoffMs, sleep } from '../core/util.js';

let conn = null;
let connected = false;
let connecting = null;
let stopped = false;

export function sshConfigured() {
  return Boolean(config.unraidHost && config.sshUser && (config.sshPassword || config.sshKey));
}

function connectOnce() {
  return new Promise((resolve, reject) => {
    const c = new Client();
    const opts = {
      host: config.unraidHost,
      port: 22,
      username: config.sshUser,
      readyTimeout: 10000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
    };
    if (config.sshKey) {
      // SSH_KEY: percorso file oppure chiave PEM inline
      opts.privateKey = config.sshKey.includes('-----BEGIN') ? config.sshKey : fs.readFileSync(config.sshKey);
    } else {
      opts.password = config.sshPassword;
    }
    c.on('ready', () => resolve(c));
    c.on('error', (e) => reject(e));
    c.connect(opts);
  });
}

async function ensureConnected() {
  if (connected && conn) return conn;
  if (connecting) return connecting;
  connecting = (async () => {
    let attempt = 0;
    for (;;) {
      if (stopped) throw new Error('SSH fermato');
      try {
        const c = await connectOnce();
        conn = c;
        connected = true;
        log.info('[ssh] connesso a', config.unraidHost);
        c.on('close', () => {
          connected = false;
          conn = null;
          log.warn('[ssh] connessione chiusa');
        });
        c.on('error', () => { connected = false; });
        return c;
      } catch (e) {
        attempt += 1;
        const wait = backoffMs(attempt, 2000, 60000);
        log.warn(`[ssh] connessione fallita (${e.message}), retry tra ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
  })().finally(() => { connecting = null; });
  return connecting;
}

export function sshClose() {
  stopped = true;
  try { conn?.end(); } catch { /* ignora */ }
  conn = null;
  connected = false;
}

// Esegue un comando remoto → { code, stdout, stderr }
export async function sshExec(command, timeoutMs = 20000) {
  const c = await ensureConnected();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout SSH: ${command.slice(0, 60)}`)), timeoutMs);
    c.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let stdout = '', stderr = '';
      stream.on('data', (d) => { stdout += d; });
      stream.stderr.on('data', (d) => { stderr += d; });
      stream.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 0, stdout, stderr });
      });
    });
  });
}

// ---- Parser INI emhttp ----
// var.ini: chiave="valore" senza sezioni. disks.ini/shares.ini: sezioni ["nome"].
export function parseIni(text) {
  const root = {};
  let cur = root;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = line.match(/^\[(?:"([^"]*)"|([^\]]*))\]$/);
    if (sec) {
      const name = sec[1] ?? sec[2];
      cur = root[name] = {};
      continue;
    }
    const kv = line.match(/^([^=]+)=(?:"([^"]*)"|(.*))$/);
    if (kv) cur[kv[1].trim()] = (kv[2] ?? kv[3] ?? '').trim();
  }
  return root;
}

export async function readIni(file) {
  const { code, stdout } = await sshExec(`cat /var/local/emhttp/${file}`);
  if (code !== 0) throw new Error(`lettura ${file} fallita`);
  return parseIni(stdout);
}

// ---- Sezioni dati ----
export async function sshArray() {
  const v = await readIni('var.ini');
  const size = parseInt(v.mdResyncSize || '0', 10) || 0;      // in KB (settori/2)
  const pos = parseInt(v.mdResyncPos || '0', 10) || 0;
  const active = parseInt(v.mdResync || '0', 10) > 0;
  return {
    state: (v.mdState || 'UNKNOWN').toUpperCase(),            // STARTED | STOPPED | ...
    numDisks: parseInt(v.mdNumDisks || '0', 10),
    numInvalid: parseInt(v.mdNumInvalid || '0', 10),
    parity: {
      running: active,
      pos, size,
      pct: active && size > 0 ? Math.round((pos / size) * 10000) / 100 : null,
      correcting: v.mdResyncCorr === '1',
      action: v.mdResyncAction || null,                        // check P | recon P | clear
      errors: parseInt(v.sbSyncErrs || '0', 10),
      paused: active && parseInt(v.mdResyncDt || '0', 10) === 0,
    },
    lastParityErrors: parseInt(v.sbSyncErrs || '0', 10),
  };
}

// Temperatura e spin state SEMPRE da disks.ini (mai smartctl periodico:
// non sveglia i dischi in spin-down).
export async function sshDisks() {
  const d = await readIni('disks.ini');
  return Object.values(d).filter(x => x.name).map(x => ({
    idx: parseInt(x.idx ?? '-1', 10),
    name: x.name,
    device: x.device || null,
    id: x.id || null,
    size: (parseInt(x.size || '0', 10) || 0) * 1024,          // KB → byte
    temp: x.temp === '*' || x.temp === '' ? null : parseInt(x.temp, 10),
    spunDown: x.spundown === '1' || x.temp === '*',
    numErrors: parseInt(x.numErrors || '0', 10),
    numReads: parseInt(x.numReads || '0', 10),
    numWrites: parseInt(x.numWrites || '0', 10),
    fsType: x.fsType || null,
    fsSize: (parseInt(x.fsSize || '0', 10) || 0) * 1024,
    fsFree: (parseInt(x.fsFree || '0', 10) || 0) * 1024,
    fsUsed: (parseInt(x.fsUsed || '0', 10) || 0) * 1024,
    status: x.status || null,                                  // DISK_OK, DISK_NP, ...
    type: x.type || null,                                      // Parity | Data | Cache | Flash
    color: x.color || null,
  }));
}

export async function sshShares() {
  const s = await readIni('shares.ini');
  return Object.entries(s).filter(([, v]) => typeof v === 'object').map(([name, v]) => ({
    name,
    free: (parseInt(v.free || '0', 10) || 0) * 1024,
    size: (parseInt(v.size || '0', 10) || 0) * 1024,
    used: v.size && v.free ? (parseInt(v.size, 10) - parseInt(v.free, 10)) * 1024 : null,
    cache: v.useCache || null,
    comment: v.comment || '',
  }));
}

// Sistema: /proc/stat (delta CPU tra poll), /proc/meminfo, uptime, sensors, load.
let prevCpu = null;
export async function sshSystem() {
  const { stdout } = await sshExec(
    `cat /proc/stat | head -1; echo ---; cat /proc/meminfo | head -5; echo ---; cat /proc/uptime; echo ---; cat /proc/loadavg; echo ---; sensors -A 2>/dev/null | head -30 || true`);
  const [statS, memS, upS, loadS, sensS] = stdout.split('---').map(s => s.trim());

  // CPU% dal delta di /proc/stat
  const f = statS.split(/\s+/).slice(1).map(Number);
  const idle = f[3] + (f[4] || 0);
  const total = f.reduce((a, b) => a + b, 0);
  let cpuPct = null;
  if (prevCpu && total > prevCpu.total) {
    cpuPct = Math.round((1 - (idle - prevCpu.idle) / (total - prevCpu.total)) * 1000) / 10;
  }
  prevCpu = { idle, total };

  const mem = {};
  for (const line of memS.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (m) mem[m[1]] = parseInt(m[2], 10) * 1024;
  }
  const uptimeSec = parseFloat(upS.split(/\s+/)[0]) || 0;
  const load = loadS.split(/\s+/).slice(0, 3).map(Number);

  // Temperature CPU/MB da sensors (best effort)
  const temps = {};
  for (const line of (sensS || '').split('\n')) {
    const m = line.match(/^([\w .-]+):\s+\+?([\d.]+)°C/);
    if (m) temps[m[1].trim()] = parseFloat(m[2]);
  }
  return {
    cpuPct,
    load,
    memTotal: mem.MemTotal || 0,
    memFree: mem.MemFree || 0,
    memAvailable: mem.MemAvailable || 0,
    memUsed: (mem.MemTotal || 0) - (mem.MemAvailable || mem.MemFree || 0),
    uptimeSec,
    temps,
  };
}

// Pool cache (ZFS/BTRFS): salute + scrub via zpool status -x e btrfs dev stats.
export async function sshPools() {
  const pools = [];
  const zp = await sshExec(`zpool list -H -o name,health,size,alloc,free 2>/dev/null || true`);
  for (const line of zp.stdout.trim().split('\n')) {
    if (!line.trim()) continue;
    const [name, health, size, alloc, free] = line.split('\t');
    pools.push({ name, type: 'zfs', health, size, used: alloc, free });
  }
  const zx = await sshExec(`zpool status -x 2>/dev/null || true`);
  const zfsAllHealthy = zx.stdout.includes('all pools are healthy') || zx.stdout.trim() === '';
  for (const p of pools) p.degraded = !zfsAllHealthy && p.health !== 'ONLINE' ? true : p.health !== 'ONLINE';

  // BTRFS: mountpoint da /proc/mounts, errori da device stats
  const bt = await sshExec(`grep btrfs /proc/mounts | awk '{print $2}' | grep '^/mnt/' | sort -u || true`);
  for (const mnt of bt.stdout.trim().split('\n')) {
    if (!mnt.trim() || mnt.startsWith('/mnt/user')) continue;
    const st = await sshExec(`btrfs device stats '${mnt}' 2>/dev/null | awk -F' ' '{s+=$2} END {print s+0}'`);
    const errors = parseInt(st.stdout.trim(), 10) || 0;
    const dfRes = await sshExec(`df -B1 --output=size,used,avail '${mnt}' | tail -1`);
    const [size, used, free] = dfRes.stdout.trim().split(/\s+/).map(Number);
    pools.push({
      name: mnt.replace('/mnt/', ''), type: 'btrfs',
      health: errors > 0 ? 'ERRORS' : 'OK', degraded: errors > 0,
      size, used, free, errors,
    });
  }
  return pools;
}

// VM via virsh.
export async function sshVms() {
  const { stdout, code } = await sshExec(`virsh list --all 2>/dev/null || true`);
  if (code !== 0) return [];
  const vms = [];
  for (const line of stdout.split('\n').slice(2)) {
    const m = line.trim().match(/^(-|\d+)\s+(\S.*?)\s+(\w[\w ]*)$/);
    if (m) vms.push({ name: m[2].trim(), state: m[3].trim().replace(' ', '-'), uuid: null });
  }
  return vms;
}
export async function sshVmAction(name, action) {
  const cmd = { start: 'start', stop: 'shutdown', forceStop: 'destroy', reboot: 'reboot', pause: 'suspend', resume: 'resume' }[action];
  if (!cmd) throw new Error(`azione VM sconosciuta: ${action}`);
  const safe = name.replace(/'/g, `'\\''`);
  const { code, stderr } = await sshExec(`virsh ${cmd} '${safe}'`);
  if (code !== 0) throw new Error(stderr.trim() || `virsh ${cmd} fallito`);
}

// Array e parity via mdcmd (solo start/stop/check, come da spec).
export async function sshArrayAction(action) {
  const cmd = { start: 'mdcmd start', stop: 'mdcmd stop' }[action];
  if (!cmd) throw new Error(`azione array sconosciuta: ${action}`);
  const { code, stderr } = await sshExec(cmd);
  if (code !== 0) throw new Error(stderr.trim() || `${cmd} fallito`);
}
export async function sshParityAction(action, correct = false) {
  const cmd = {
    start: `mdcmd check ${correct ? 'CORRECT' : 'NOCORRECT'}`,
    pause: 'mdcmd nocheck PAUSE',
    resume: 'mdcmd check RESUME',
    cancel: 'mdcmd nocheck',
  }[action];
  if (!cmd) throw new Error(`azione parity sconosciuta: ${action}`);
  const { code, stderr } = await sshExec(cmd);
  if (code !== 0) throw new Error(stderr.trim() || `${cmd} fallito`);
}

// Power host (fallback SSH).
export async function sshPower(action) {
  const cmd = { reboot: 'powerdown -r', shutdown: 'powerdown' }[action];
  if (!cmd) throw new Error(`azione power sconosciuta: ${action}`);
  // powerdown chiude anche la connessione: non aspettare l'exit code
  sshExec(cmd, 5000).catch(() => {});
}

// SMART completo SOLO on-demand, con -n standby (non sveglia i dischi).
export async function sshSmart(device) {
  if (!/^[a-z]{2,3}[a-z0-9]*$/i.test(device)) throw new Error('device non valido');
  const { stdout, stderr, code } = await sshExec(`smartctl -n standby -a /dev/${device} 2>&1 || true`, 30000);
  return { output: stdout || stderr, standby: code === 2 || /Device is in STANDBY/i.test(stdout) };
}

// Storico parity da /boot/config/parity-checks.log
// Formato riga: "YYYY Mon DD HH:MM:SS|durata_s|velocità|errori[|azione|dimensione...]"
export async function sshParityHistory() {
  const { stdout } = await sshExec(`cat /boot/config/parity-checks.log 2>/dev/null || true`);
  return parseParityLog(stdout);
}

export function parseParityLog(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 2) continue;
    out.push({
      date: parts[0]?.trim() || null,
      durationSec: parseInt(parts[1], 10) || null,
      speed: parts[2]?.trim() || null,
      errors: parts[3] !== undefined ? parseInt(parts[3], 10) : null,
      elapsed: parts[4]?.trim() || null,
      action: parts[5]?.trim() || null,
      size: parts[6] ? parseInt(parts[6], 10) : null,
    });
  }
  return out.reverse(); // più recenti prima
}
