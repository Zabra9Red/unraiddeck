// Flusso update: conferma con lista dipendenti net=container: (pattern VPN),
// opzione rimozione vecchia immagine, progresso pull/fasi via ws, esito.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { getSocket, subscribe } from '../socket.js';
import { Modal } from './Modal.jsx';
import { Btn, Badge, Spinner } from './ui.jsx';
import { t } from '../i18n.js';
import { useToast } from './Toast.jsx';

export function UpdateModal({ container, onClose, onDone }) {
  const toast = useToast();
  const [dependents, setDependents] = useState(null);
  const [removeOld, setRemoveOld] = useState(true);
  const [phase, setPhase] = useState(null);      // null = conferma; poi fasi
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/containers/${container.id}/dependents`).then(setDependents).catch(() => setDependents([]));
  }, [container.id]);

  useEffect(() => {
    const unsub = subscribe(`update:${container.shortId}`);
    const s = getSocket();
    const onProgress = (msg) => {
      if (msg.id !== container.shortId) return;
      setPhase(msg.phase);
      setProgress(msg);
    };
    s.on('update:progress', onProgress);
    return () => { s.off('update:progress', onProgress); unsub(); };
  }, [container.shortId]);

  const start = async () => {
    setPhase('pull');
    setError(null);
    try {
      const out = await api.post(`/containers/${container.id}/update`, { removeOldImage: removeOld });
      setResult(out);
      if (out.status === 'uptodate') toast.info(container.name, t.upToDate);
      else if (out.status === 'helper-started') toast.info(container.name, t.updateSelfNote);
      else toast.ok(container.name, 'Update completato');
      onDone?.();
    } catch (e) {
      setError(e.message);
      toast.error(container.name, e.message);
    }
  };

  const phaseLabels = {
    pull: 'Pull immagine', stop: 'Stop', create: 'Ricreazione', start: 'Avvio',
    verify: 'Verifica', dependents: 'Dipendenti', cleanup: 'Pulizia',
    rollback: 'ROLLBACK', done: 'Completato', error: 'Errore',
  };

  return (
    <Modal title={t.updateTitle(container.name)} onClose={onClose}>
      {phase === null && (
        <>
          {container.isSelf && (
            <div className="mb-3 p-3 rounded-lg bg-blue/10 border border-blue/40 text-blue text-sm">{t.updateSelfNote}</div>
          )}
          <div className="text-sm text-subtext1 mb-2">
            <span className="text-subtext0">{t.image}:</span> <code className="text-text">{container.image}</code>
          </div>
          <div className="mb-3">
            <div className="text-sm text-subtext0 mb-1.5">{dependents === null ? <Spinner /> : dependents.length ? t.updateDependents : t.updateNoDependents}</div>
            {dependents?.length > 0 && (
              <ul className="space-y-1">
                {dependents.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-sm">
                    <Badge color="peach">{d.byName ? 'riavvio' : 'ricreazione'}</Badge>
                    <span>{d.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-subtext1 cursor-pointer">
            <input type="checkbox" checked={removeOld} onChange={(e) => setRemoveOld(e.target.checked)} className="accent-[#89b4fa]" />
            {t.updateRemoveOld}
          </label>
          <div className="flex justify-end gap-2 mt-5">
            <Btn variant="ghost" onClick={onClose}>{t.cancel}</Btn>
            <Btn variant="primary" onClick={start}>{t.stUpdate}</Btn>
          </div>
        </>
      )}

      {phase !== null && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            {!result && !error && <Spinner />}
            <span className={error ? 'text-red' : phase === 'done' ? 'text-green' : 'text-text'}>
              {phaseLabels[phase] || phase}{progress?.status ? ` — ${progress.status}` : ''}
            </span>
          </div>
          {progress?.layer && progress?.progress?.total > 0 && (
            <div>
              <div className="text-xs text-overlay0 mb-1 font-mono">{progress.layer}</div>
              <div className="h-1.5 rounded-full bg-surface0 overflow-hidden">
                <div className="h-full bg-blue rounded-full transition-[width]" style={{ width: `${Math.min(100, (progress.progress.current / progress.progress.total) * 100)}%` }} />
              </div>
            </div>
          )}
          {error && <div className="text-sm text-red bg-red/10 border border-red/30 rounded-lg px-3 py-2">{error}</div>}
          {result?.dependents?.some((d) => !d.ok) && (
            <div className="text-sm text-peach">
              Dipendenti con errori: {result.dependents.filter((d) => !d.ok).map((d) => `${d.name}: ${d.error}`).join('; ')}
            </div>
          )}
          {(result || error) && (
            <div className="flex justify-end">
              <Btn onClick={onClose}>{t.close}</Btn>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
