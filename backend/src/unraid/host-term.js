// Terminale host Unraid via SSH (shell PTY su socket.io, xterm lato client).
// Stesso modello della console exec dei container: TTY con resize, cleanup su
// disconnect, timeout inattività 15 min, max 2 sessioni per utente, audit.
import crypto from 'node:crypto';
import { sshConfigured, sshShell } from './ssh-fallback.js';
import { config } from '../core/config.js';
import { audit } from '../core/audit.js';
import { log } from '../core/util.js';

const IDLE_TIMEOUT = 15 * 60000;
const MAX_PER_USER = 2;
const sessions = new Map(); // sid -> { stream, socketId, user, idleTimer }

function armIdle(sess) {
  if (sess.idleTimer) clearTimeout(sess.idleTimer);
  sess.idleTimer = setTimeout(() => {
    sess.onTimeout?.();
    closeSession(sess.sid, 'timeout inattività');
  }, IDLE_TIMEOUT);
}

export function initHostTermHub(io) {
  io.on('connection', (socket) => {
    socket.on('hostterm:start', async ({ cols, rows } = {}, ack) => {
      const user = socket.data.user;
      try {
        if (!sshConfigured()) {
          return ack?.({ error: 'Terminale host: servono le credenziali SSH (SSH_USER + SSH_PASSWORD o SSH_KEY)' });
        }
        const count = [...sessions.values()].filter(s => s.user === user.username).length;
        if (count >= MAX_PER_USER) {
          return ack?.({ error: `Massimo ${MAX_PER_USER} terminali host per utente` });
        }
        const stream = await sshShell({ cols, rows });
        const sid = crypto.randomBytes(8).toString('hex');
        const sess = { sid, stream, socketId: socket.id, user: user.username, idleTimer: null };
        sessions.set(sid, sess);
        armIdle(sess);
        sess.onTimeout = () => socket.emit('hostterm:end', { sid, reason: 'Timeout inattività (15 min)' });

        stream.on('data', (chunk) => {
          socket.emit('hostterm:data', { sid, data: chunk.toString('base64') });
        });
        stream.stderr?.on('data', (chunk) => {
          socket.emit('hostterm:data', { sid, data: chunk.toString('base64') });
        });
        stream.on('close', () => {
          socket.emit('hostterm:end', { sid, reason: 'Sessione terminata' });
          closeSession(sid, 'terminata');
        });
        stream.on('error', () => closeSession(sid, 'errore stream'));

        audit(user.username, 'hostterm.start', config.unraidHost, 'ok', socket.handshake.address);
        ack?.({ sid });
      } catch (e) {
        audit(user.username, 'hostterm.start', config.unraidHost, 'errore', socket.handshake.address, e.message);
        ack?.({ error: e.message });
      }
    });

    socket.on('hostterm:input', ({ sid, data }) => {
      const sess = sessions.get(sid);
      if (!sess || sess.socketId !== socket.id) return;
      armIdle(sess);
      try { sess.stream.write(Buffer.from(data, 'base64')); } catch { /* stream chiuso */ }
    });

    socket.on('hostterm:resize', ({ sid, cols, rows }) => {
      const sess = sessions.get(sid);
      if (!sess || sess.socketId !== socket.id) return;
      try { sess.stream.setWindow(Math.max(1, rows | 0), Math.max(1, cols | 0), 0, 0); } catch { /* ignora */ }
    });

    socket.on('hostterm:close', ({ sid }) => {
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
  try { sess.stream.end(); } catch { /* ignora */ }
  audit(sess.user, 'hostterm.end', config.unraidHost, 'ok', null, reason);
  log.info(`[hostterm] sessione ${sid} chiusa (${reason})`);
}

export function closeAllHostTermSessions() {
  for (const sid of [...sessions.keys()]) closeSession(sid, 'shutdown');
}
