// Socket.io: auth + verifica Origin sull'handshake (anti cross-site WebSocket
// hijacking), rooms: events, stats, logs:<id>, unraid, notify, update:<id>.
// Il server è l'UNICA sorgente di streaming: 1 sorgente Docker → N client.
import { socketAuth, socketOriginOk } from '../core/auth.js';
import { initStatsHub } from '../docker/stats-hub.js';
import { initLogsHub } from '../docker/logs.js';
import { initExecHub } from '../docker/exec.js';
import { log } from '../core/util.js';

const ROOM_RX = /^(events|stats|unraid|notify|logs:[0-9a-f]{12,64}|update:[0-9a-f]{12})$/;

export function initSockets(io) {
  io.use((socket, next) => {
    if (!socketOriginOk(socket.handshake)) {
      return next(new Error('Origin non valida'));
    }
    const user = socketAuth(socket.handshake);
    if (!user) return next(new Error('Non autenticato'));
    socket.data.user = user;
    next();
  });

  initStatsHub(io);
  initLogsHub(io);
  initExecHub(io);

  io.on('connection', (socket) => {
    socket.on('subscribe', (room) => {
      if (typeof room === 'string' && ROOM_RX.test(room)) socket.join(room);
    });
    socket.on('unsubscribe', (room) => {
      if (typeof room === 'string') socket.leave(room);
    });
  });

  log.info('[sockets] hub inizializzati (events, stats, logs, exec, unraid, notify)');
}
