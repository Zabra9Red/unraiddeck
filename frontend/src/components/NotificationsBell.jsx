// Campanella notifiche: badge non lette, dropdown lista, toast su push ws.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { getSocket, subscribe } from '../socket.js';
import { Dropdown, Btn, Badge, EmptyState } from './ui.jsx';
import { useToast } from './Toast.jsx';
import { t, fmtTs } from '../i18n.js';

export function NotificationsBell() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState([]);
  const [unread, setUnread] = useState(0);

  const load = () => api.get('/notifications?limit=30').then((d) => { setList(d.rows); setUnread(d.unread); }).catch(() => {});

  useEffect(() => {
    load();
    const unsub = subscribe('notify');
    const s = getSocket();
    const onNew = (n) => {
      setList((prev) => [n, ...prev].slice(0, 30));
      setUnread((u) => u + 1);
      const fn = { error: toast.error, warning: toast.warn, info: toast.info }[n.severity] || toast.info;
      fn(n.title, n.body);
    };
    s.on('notify:new', onNew);
    return () => { s.off('notify:new', onNew); unsub(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const markAll = async () => {
    await api.post('/notifications/read').catch(() => {});
    setUnread(0);
    setList((prev) => prev.map((n) => ({ ...n, read: 1 })));
  };

  const sevColor = { error: 'red', warning: 'peach', info: 'blue' };

  return (
    <Dropdown
      open={open}
      setOpen={setOpen}
      button={
        <button onClick={() => { setOpen(!open); if (!open) load(); }} className="relative p-2 rounded-lg hover:bg-surface0 transition-colors cursor-pointer" aria-label={t.notifications}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-subtext0">
            <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 01-3.4 0" />
          </svg>
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 bg-red text-crust text-[10px] font-bold rounded-full min-w-4 h-4 px-1 flex items-center justify-center">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      }
    >
      <div className="w-80 max-w-[85vw]">
        <div className="flex items-center justify-between px-3 py-2 border-b border-surface0">
          <span className="text-sm font-medium">{t.notifications}</span>
          <Btn size="sm" variant="ghost" onClick={markAll}>{t.markAllRead}</Btn>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {list.length ? list.map((n) => (
            <div key={n.id} className={`px-3 py-2 border-b border-surface0/50 ${n.read ? 'opacity-60' : ''}`}>
              <div className="flex items-center gap-1.5">
                <Badge color={sevColor[n.severity] || 'blue'}>{n.severity}</Badge>
                <span className="text-sm font-medium truncate">{n.title}</span>
              </div>
              {n.body && <div className="text-xs text-subtext0 mt-0.5">{n.body}</div>}
              <div className="text-[10px] text-overlay0 mt-0.5">{fmtTs(n.ts)}</div>
            </div>
          )) : <EmptyState>{t.noNotifications}</EmptyState>}
        </div>
      </div>
    </Dropdown>
  );
}
