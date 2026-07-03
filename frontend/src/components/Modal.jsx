// Modal + conferma digitata (nome risorsa) per azioni distruttive.
import { useEffect, useState } from 'react';
import { Btn, Input } from './ui.jsx';
import { t } from '../i18n.js';

export function Modal({ title, children, onClose, wide = false }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-crust/70 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`bg-base border border-surface1 rounded-xl shadow-2xl shadow-crust w-full ${wide ? 'max-w-3xl' : 'max-w-md'} max-h-[85vh] flex flex-col`}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-surface0">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="text-overlay0 hover:text-text text-xl leading-none cursor-pointer" aria-label={t.close}>×</button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

// Conferma con nome digitato: usata per remove container, kill, stop array,
// reboot/shutdown host; variante rafforzata per il self (UnraidDeck stesso).
export function ConfirmTyped({ title, body, expected, danger = true, selfWarning = false, onConfirm, onClose, busy }) {
  const [typed, setTyped] = useState('');
  const ok = typed === expected;
  return (
    <Modal title={title} onClose={onClose}>
      {selfWarning && (
        <div className="mb-3 p-3 rounded-lg bg-red/10 border border-red/40 text-red text-sm">
          <strong>{t.confirmSelfTitle}</strong>
          <div className="text-red/90 mt-1">{t.confirmSelfBody}</div>
        </div>
      )}
      <p className="text-sm text-subtext1 mb-4">{body}</p>
      <Input
        label={t.confirmTyped(expected)}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={expected}
        autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter' && ok) onConfirm(); }}
      />
      <div className="flex justify-end gap-2 mt-5">
        <Btn variant="ghost" onClick={onClose}>{t.cancel}</Btn>
        <Btn variant={danger ? 'danger' : 'primary'} disabled={!ok || busy} onClick={onConfirm}>
          {busy ? '…' : t.confirm}
        </Btn>
      </div>
    </Modal>
  );
}
