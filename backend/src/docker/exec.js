// Console exec (xterm.js lato client): TTY con resize, cleanup su disconnect,
// timeout inattività 15 min, max 3 sessioni per utente. Sessioni in audit.
import crypto from 'node:crypto';
import { docker } from './manager.js';
import { audit } from '../core/audit.js';
import { log } from '../core/util.js';

const IDLE_TIMEOUT = 15 * 60000;
const MAX_PER_USER = 3;
const sessions = new Map(); // sid -> { exec, stream, socketId, user, containerName, idleTimer }

function armIdle(sess) {
  if (sess.idleTimer) clearTimeout(sess.idleTimer);
  sess.idleTimer = setTimeout(() => {
    sess.onTimeout?.();
    closeSession(sess.sid, 'timeout inattività');
  }, IDLE_TIMEOUT);
}

export function initExecHub(io) {
  io.on('connection', (socket) => {
    socket.on('exec:start', async ({ containerId }, ack) => {
      const user = socket.data.user;
      try {
        const count = [...sessions.values()].filter(s => s.user === user.username).length;
        if (count >= MAX_PER_USER) {
          return ack?.({ error: `Massimo ${MAX_PER_USER} sessioni console per utente` });
        }
        const container = docker.getContainer(containerId);
        const info = await container.inspect();
        const containerName = info.Name.replace(/^\//, '');
        const exec = await container.exec({
          AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
          // bash se presente, altrimenti sh
          Cmd: ['/bin/sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'],
        });
        const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
        const sid = crypto.randomBytes(8).toString('hex');
        const sess = { sid, exec, stream, socketId: socket.id, user: user.username, containerName, idleTimer: null };
        sessions.set(sid, sess);
        armIdle(sess);
        sess.onTimeout = () => socket.emit('exec:end', { sid, reason: 'Timeout inattività (15 min)' });

        stream.on('data', (chunk) => {
          socket.emit('exec:data', { sid, data: chunk.toString('base64') });
        });
        stream.on('end', () => {
          socket.emit('exec:end', { sid, reason: 'Sessione terminata' });
          closeSession(sid, 'terminata');
        });
        stream.on('error', () => closeSession(sid, 'errore stream'));

        audit(user.username, 'exec.start', containerName, 'ok', socket.handshake.address);
        ack?.({ sid });
      } catch (e) {
        audit(user.username, 'exec.start', containerId.slice(0, 12), 'errore', socket.handshake.address, e.message);
        ack?.({ error: e.message });
      }
    });

    socket.on('exec:input', ({ sid, data }) => {
      const sess = sessions.get(sid);
      if (!sess || sess.socketId !== socket.id) return;
      armIdle(sess);
      try { sess.stream.write(Buffer.from(data, 'base64')); } catch { /* stream chiuso */ }
    });

    socket.on('exec:resize', async ({ sid, cols, rows }) => {
      const sess = sessions.get(sid);
      if (!sess || sess.socketId !== socket.id) return;
      try { await sess.exec.resize({ w: Math.max(1, cols | 0), h: Math.max(1, rows | 0) }); } catch { /* ignora */ }
    });

    socket.on('exec:close', ({ sid }) => {
      const sess = sessions.get(sid);
      if (sess && sess.socketId === socket.id) closeSession(sid, 'chiusa dal client');
    });

    socket.on('disconnect', () => {
      for (const [sid, sess] of sessions) {
        if (sess.socketId === socket.id) closeSession(sid, 'disconnect');
      }
    });
  });
}

function closeSession(sid, reason) {
  const sess = sessions.get(sid);
  if (!sess) return;
  sessions.delete(sid);
  if (sess.idleTimer) clearTimeout(sess.idleTimer);
  try { sess.stream.end(); sess.stream.destroy(); } catch { /* ignora */ }
  audit(sess.user, 'exec.end', sess.containerName, 'ok', null, reason);
  log.info(`[exec] sessione ${sid} chiusa (${reason})`);
}

export function closeAllExecSessions() {
  for (const sid of [...sessions.keys()]) closeSession(sid, 'shutdown');
}
