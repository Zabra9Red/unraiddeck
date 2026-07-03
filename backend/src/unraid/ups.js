// UPS senza mount: apcupsd NIS tcp/3551 (protocollo apcaccess) oppure
// NUT tcp/3493 (upsc) verso UNRAID_HOST. Auto-rilevamento, cache della modalità.
import net from 'node:net';
import { config } from '../core/config.js';

let detectedMode = null; // 'apc' | 'nut' | 'none'

// ---- apcupsd NIS: frame length-prefixed (2 byte BE) ----
function apcStatus(host, port = 3551, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    const chunks = [];
    sock.on('connect', () => {
      const cmd = Buffer.from('status', 'ascii');
      const frame = Buffer.alloc(2 + cmd.length);
      frame.writeUInt16BE(cmd.length, 0);
      cmd.copy(frame, 2);
      sock.write(frame);
    });
    sock.on('data', (d) => chunks.push(d));
    sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout apcupsd')); });
    sock.on('error', reject);
    sock.on('close', () => {
      const buf = Buffer.concat(chunks);
      const lines = [];
      let off = 0;
      while (off + 2 <= buf.length) {
        const len = buf.readUInt16BE(off);
        off += 2;
        if (len === 0) break;
        lines.push(buf.subarray(off, off + len).toString('ascii').trim());
        off += len;
      }
      if (!lines.length) return reject(new Error('risposta apcupsd vuota'));
      const kv = {};
      for (const line of lines) {
        const i = line.indexOf(':');
        if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      resolve(kv);
    });
  });
}

// ---- NUT: protocollo testuale ----
function nutRequest(host, port = 3493, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    let buf = '';
    let phase = 0; // 0: LIST UPS, 1: LIST VAR
    let upsName = null;
    const vars = {};
    sock.on('connect', () => sock.write('LIST UPS\n'));
    sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout NUT')); });
    sock.on('error', reject);
    sock.on('data', (d) => {
      buf += d.toString('ascii');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith('ERR')) { sock.destroy(); return reject(new Error(`NUT: ${line}`)); }
        if (phase === 0) {
          const m = line.match(/^UPS\s+(\S+)/);
          if (m) upsName = m[1];
          if (line.startsWith('END LIST UPS')) {
            if (!upsName) { sock.destroy(); return reject(new Error('nessun UPS registrato su NUT')); }
            phase = 1;
            sock.write(`LIST VAR ${upsName}\n`);
          }
        } else {
          const m = line.match(/^VAR\s+\S+\s+(\S+)\s+"(.*)"$/);
          if (m) vars[m[1]] = m[2];
          if (line.startsWith('END LIST VAR')) {
            sock.end('LOGOUT\n');
            return resolve({ upsName, vars });
          }
        }
      }
    });
  });
}

// Normalizza in un DTO comune.
export async function upsStatus() {
  const host = config.unraidHost;
  if (!host) return null;

  const tryApc = async () => {
    const kv = await apcStatus(host);
    return {
      mode: 'apc',
      model: kv.MODEL || kv.UPSNAME || null,
      status: kv.STATUS || null,                       // ONLINE | ONBATT | ...
      onBattery: /ONBATT/i.test(kv.STATUS || ''),
      chargePct: parseFloat(kv.BCHARGE) || null,
      loadPct: parseFloat(kv.LOADPCT) || null,
      runtimeMin: parseFloat(kv.TIMELEFT) || null,
      lineV: parseFloat(kv.LINEV) || null,
    };
  };
  const tryNut = async () => {
    const { upsName, vars } = await nutRequest(host);
    const status = vars['ups.status'] || null;         // OL | OB | LB ...
    return {
      mode: 'nut',
      model: vars['device.model'] || upsName,
      status,
      onBattery: /\bOB\b/.test(status || ''),
      chargePct: parseFloat(vars['battery.charge']) || null,
      loadPct: parseFloat(vars['ups.load']) || null,
      runtimeMin: vars['battery.runtime'] ? Math.round(parseFloat(vars['battery.runtime']) / 60) : null,
      lineV: parseFloat(vars['input.voltage']) || null,
    };
  };

  const order = detectedMode === 'nut' ? [tryNut, tryApc] : [tryApc, tryNut];
  for (const fn of order) {
    try {
      const res = await fn();
      detectedMode = res.mode;
      return res;
    } catch { /* prova il prossimo */ }
  }
  detectedMode = 'none';
  return null;
}
