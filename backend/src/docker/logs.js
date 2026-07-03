// Log container: follow con demux stdout/stderr, tail 500, coalescing lato
// server (flush ≤100ms), download in streaming (mai bufferizzare in RAM).
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { docker } from './manager.js';
import { createDockerDemuxer, log } from '../core/util.js';

const FLUSH_MS = 100;
const active = new Map(); // containerId -> { stream, buffer, timer, tty }

export function initLogsHub(io) {
  io.of('/').adapter.on('join-room', async (room, sid) => {
    if (!room.startsWith('logs:')) return;
    const id = room.slice(5);
    if (!active.has(id)) await startLogStream(io, id);
  });
  io.of('/').adapter.on('leave-room', (room) => {
    if (!room.startsWith('logs:')) return;
    const id = room.slice(5);
    const members = io.sockets.adapter.rooms.get(room)?.size || 0;
    if (members === 0) stopLogStream(id);
  });
}

async function startLogStream(io, id) {
  try {
    const container = docker.getContainer(id);
    const info = await container.inspect();
    const tty = Boolean(info.Config?.Tty);
    const stream = await container.logs({
      follow: true, stdout: true, stderr: true, tail: 500, timestamps: false,
    });

    const entry = { stream, lines: [], timer: null, tty };
    active.set(id, entry);

    const push = (src, text) => {
      // src: 1=stdout 2=stderr
      for (const line of text.split('\n')) {
        if (line.length) entry.lines.push([src, line]);
      }
      if (!entry.timer) {
        entry.timer = setTimeout(() => {
          entry.timer = null;
          if (entry.lines.length) {
            io.to(`logs:${id}`).emit('logs:data', { id, chunks: entry.lines.splice(0, entry.lines.length) });
          }
        }, FLUSH_MS);
      }
    };

    if (tty) {
      stream.on('data', (chunk) => push(1, chunk.toString('utf8')));
    } else {
      const demux = createDockerDemuxer((type, buf) => push(type === 2 ? 2 : 1, buf.toString('utf8')));
      stream.on('data', demux);
    }
    const cleanup = () => {
      io.to(`logs:${id}`).emit('logs:end', { id });
      stopLogStream(id);
    };
    stream.on('error', cleanup);
    stream.on('end', cleanup);
  } catch (e) {
    log.warn(`[logs] stream ${id.slice(0, 12)} fallito:`, e.message);
    io.to(`logs:${id}`).emit('logs:error', { id, error: e.message });
  }
}

function stopLogStream(id) {
  const entry = active.get(id);
  if (!entry) return;
  active.delete(id);
  if (entry.timer) clearTimeout(entry.timer);
  try { entry.stream.destroy(); } catch { /* ignora */ }
}

export function stopAllLogStreams() {
  for (const id of [...active.keys()]) stopLogStream(id);
}

// Download in streaming: richiesta raw all'API Docker (con follow=false
// dockerode bufferizza tutto in RAM — qui si pipa direttamente), demux → testo.
function dockerRawStream(path) {
  const modem = docker.modem;
  const opts = modem.socketPath
    ? { socketPath: modem.socketPath, path, method: 'GET' }
    : { host: modem.host, port: modem.port, path, method: 'GET' };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res2) => {
      if (res2.statusCode >= 400) {
        res2.resume();
        return reject(new Error(`Docker API HTTP ${res2.statusCode}`));
      }
      resolve(res2);
    });
    req.on('error', reject);
    req.end();
  });
}

export async function streamLogsDownload(id, res, tail = 'all') {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  const name = info.Name.replace(/^\//, '');
  const q = new URLSearchParams({
    follow: '0', stdout: '1', stderr: '1', timestamps: '1',
    tail: tail === 'all' ? 'all' : String(parseInt(tail, 10) || 500),
  });
  const stream = await dockerRawStream(`/containers/${info.Id}/logs?${q}`);
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${name}-logs.txt"`);
  if (info.Config?.Tty) {
    stream.pipe(res);
  } else {
    const out = new PassThrough();
    const demux = createDockerDemuxer((_type, buf) => out.write(buf));
    stream.on('data', demux);
    stream.on('end', () => out.end());
    stream.on('error', () => out.end());
    out.pipe(res);
  }
  res.on('close', () => { try { stream.destroy(); } catch { /* ignora */ } });
}
