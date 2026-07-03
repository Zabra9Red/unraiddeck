// Toast globali (context) — successi, errori, notifiche push in-app.
import { createContext, useCallback, useContext, useState } from 'react';

const ToastCtx = createContext(null);
let seq = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((severity, title, body = '', ttl = 5000) => {
    const id = ++seq;
    setToasts((ts) => [...ts, { id, severity, title, body }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), ttl);
  }, []);
  const api = {
    info: (tit, body) => push('info', tit, body),
    ok: (tit, body) => push('ok', tit, body),
    warn: (tit, body) => push('warning', tit, body, 8000),
    error: (tit, body) => push('error', tit, body, 8000),
  };
  const colors = {
    info: 'border-blue/50 text-blue',
    ok: 'border-green/50 text-green',
    warning: 'border-peach/50 text-peach',
    error: 'border-red/50 text-red',
  };
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 max-w-sm">
        {toasts.map((toast) => (
          <div key={toast.id} className={`bg-mantle border rounded-lg px-4 py-3 shadow-lg shadow-crust/50 ${colors[toast.severity] || colors.info}`}>
            <div className="text-sm font-medium">{toast.title}</div>
            {toast.body && <div className="text-xs text-subtext0 mt-0.5 break-words">{toast.body}</div>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
