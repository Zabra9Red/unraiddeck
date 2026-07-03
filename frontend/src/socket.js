// Socket.io client singleton con subscribe/unsubscribe alle room.
import { io } from 'socket.io-client';

let socket = null;

export function getSocket() {
  if (!socket) {
    socket = io({ path: '/socket.io', autoConnect: true, reconnection: true });
  }
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

// Iscrizione a una room con ri-subscribe automatica alla riconnessione.
export function subscribe(room) {
  const s = getSocket();
  s.emit('subscribe', room);
  const onReconnect = () => s.emit('subscribe', room);
  s.on('connect', onReconnect);
  return () => {
    s.off('connect', onReconnect);
    s.emit('unsubscribe', room);
  };
}
