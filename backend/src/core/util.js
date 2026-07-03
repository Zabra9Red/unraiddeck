// Utility condivise: logging, sleep, formattazioni.
export const log = {
  info: (...a) => console.log(new Date().toISOString(), '[INFO]', ...a),
  warn: (...a) => console.warn(new Date().toISOString(), '[WARN]', ...a),
  error: (...a) => console.error(new Date().toISOString(), '[ERROR]', ...a),
};

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Backoff esponenziale con cap.
export function backoffMs(attempt, baseMs = 1000, capMs = 30000) {
  return Math.min(capMs, baseMs * 2 ** Math.min(attempt, 10));
}

// Set LRU semplice per dedupe (mantiene gli ultimi N elementi).
export class LruSet {
  constructor(max = 2000) { this.max = max; this.set = new Set(); }
  has(k) { return this.set.has(k); }
  add(k) {
    if (this.set.has(k)) return;
    this.set.add(k);
    if (this.set.size > this.max) {
      const first = this.set.values().next().value;
      this.set.delete(first);
    }
  }
}

// Timeout su una promise (per chiamate esterne).
export function withTimeout(promise, ms, label = 'operazione') {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`Timeout ${label} dopo ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Demux dello stream multiplexed Docker (header 8 byte: [type,0,0,0,len32BE]).
// Gestisce frame spezzati tra chunk. onFrame(streamType, buffer).
export function createDockerDemuxer(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 8) {
      const type = buf[0];
      const len = buf.readUInt32BE(4);
      if (buf.length < 8 + len) break;
      onFrame(type, buf.subarray(8, 8 + len));
      buf = buf.subarray(8 + len);
    }
  };
}
