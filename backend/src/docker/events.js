// Stream docker /events: pilota gli aggiornamenti di stato (niente polling a regime).
// Auto-reconnect con exponential backoff, replay con since=<timeNano ultimo evento>,
// dedupe su id+action+timeNano, UNA list di riconciliazione a ogni riconnessione.
import { docker, refreshInspect, dropInspect, listContainers } from './manager.js';
import { LruSet, backoffMs, log, sleep } from '../core/util.js';
import { notify } from '../core/notify.js';

let ioRef = null;
let stopped = false;
let currentStream = null;
let lastTimeNano = null;
const seen = new LruSet(2000);

const RELEVANT = new Set(['start', 'stop', 'die', 'destroy', 'create', 'rename', 'pause', 'unpause', 'restart', 'update', 'kill', 'oom']);

export function startEvents(io) {
  ioRef = io;
  stopped = false;
  loop();
}

export function stopEvents() {
  stopped = true;
  try { currentStream?.destroy(); } catch { /* ignora */ }
}

async function loop() {
  let attempt = 0;
  while (!stopped) {
    try {
      const opts = { filters: JSON.stringify({ type: ['container'] }) };
      if (lastTimeNano) {
        // Replay dall'ultimo evento visto (secondi.nanosecondi); il piccolo
        // overlap dovuto alla precisione float è coperto dal dedupe.
        const sec = Math.floor(lastTimeNano / 1e9);
        const ns = Math.max(0, Math.floor(lastTimeNano - sec * 1e9));
        opts.since = `${sec}.${String(ns).padStart(9, '0')}`;
      }
      const stream = await docker.getEvents(opts);
      currentStream = stream;
      attempt = 0;
      log.info(`[events] stream connesso${opts.since ? ` (replay da ${opts.since})` : ''}`);
      if (lastTimeNano) reconcile(); // UNA riconciliazione a ogni riconnessione

      await consume(stream);
      if (stopped) return;
      log.warn('[events] stream terminato (restart di dockerd?), riconnessione…');
    } catch (e) {
      if (stopped) return;
      log.warn('[events] errore stream:', e.message);
    }
    const wait = backoffMs(attempt++);
    await sleep(wait);
  }
}

function consume(stream) {
  return new Promise((resolve) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { handleEvent(JSON.parse(line)); } catch { /* linea malformata */ }
      }
    });
    stream.on('error', () => resolve());
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
  });
}

async function handleEvent(ev) {
  const id = ev.Actor?.ID || ev.id;
  const action = (ev.Action || '').split(':')[0]; // "exec_create: ..." → exec_create
  const timeNano = ev.timeNano || 0;
  if (timeNano) lastTimeNano = timeNano;

  const key = `${id}:${ev.Action}:${timeNano}`;
  if (seen.has(key)) return; // dedupe replay
  seen.add(key);

  if (!RELEVANT.has(action) && action !== 'health_status') return;

  // Aggiorna cache inspect e notifica i client
  if (action === 'destroy') dropInspect(id);
  else await refreshInspect(id);

  // Notifica: container uscito con exit code != 0
  if (action === 'die') {
    const exitCode = parseInt(ev.Actor?.Attributes?.exitCode ?? '0', 10);
    const name = ev.Actor?.Attributes?.name || id.slice(0, 12);
    if (exitCode !== 0) {
      notify(`container-died:${name}`, 'error', `Container "${name}" terminato`, `Exit code ${exitCode}`);
    }
  }

  ioRef?.to('events').emit('docker:event', {
    id, action, timeNano,
    name: ev.Actor?.Attributes?.name || null,
    exitCode: ev.Actor?.Attributes?.exitCode ?? null,
  });
}

// Riconciliazione: una list completa → i client ricaricano lo stato.
async function reconcile() {
  try {
    const list = await listContainers();
    ioRef?.to('events').emit('docker:reconcile', list);
    log.info(`[events] riconciliazione completata (${list.length} container)`);
  } catch (e) {
    log.warn('[events] riconciliazione fallita:', e.message);
  }
}
