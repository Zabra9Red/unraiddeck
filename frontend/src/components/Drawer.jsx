// Drawer laterale del container: panoramica (grafici estesi + dettagli),
// log, console. Con drawer aperto le stats passano a cadenza 2s.
import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import { ContainerCharts } from './charts.jsx';
import { LogsPanel } from './LogsPanel.jsx';
import { Badge, Spinner } from './ui.jsx';

// xterm è pesante: caricato solo all'apertura della console
const ExecPanel = lazy(() => import('./ExecPanel.jsx').then((m) => ({ default: m.ExecPanel })));
import { t, fmtBytes, fmtTs } from '../i18n.js';

export function Drawer({ container, statsMap, onClose }) {
  const [tab, setTab] = useState('overview');
  const [history, setHistory] = useState([]);
  const [inspect, setInspect] = useState(null);

  // Cadenza stats 2s con drawer aperto
  useEffect(() => {
    const s = getSocket();
    s.emit('stats:fast', true);
    return () => s.emit('stats:fast', false);
  }, []);

  useEffect(() => {
    api.get(`/containers/${container.id}/stats-history`).then(setHistory).catch(() => {});
    api.get(`/containers/${container.id}`).then(setInspect).catch(() => {});
  }, [container.id]);

  // Aggiungi i punti live dal batch
  useEffect(() => {
    const point = statsMap?.[container.id];
    if (!point) return;
    setHistory((prev) => {
      if (prev.length && prev[prev.length - 1].ts >= point.ts) return prev;
      const next = prev.concat(point);
      return next.length > 120 ? next.slice(next.length - 120) : next;
    });
  }, [statsMap, container.id]);

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const tabs = [
    ['overview', t.overview],
    ['logs', t.stLogs],
    ['console', t.stConsole],
  ];

  const mounts = inspect?.Mounts || [];
  const env = inspect?.Config?.Env || [];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-crust/50" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full sm:w-[640px] max-w-full h-full bg-base border-l border-surface1 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-surface0">
          <div className="min-w-0">
            <h2 className="font-semibold truncate">{container.name}</h2>
            <div className="text-xs text-overlay0 truncate">{container.image}</div>
          </div>
          <button onClick={onClose} className="text-overlay0 hover:text-text text-2xl leading-none ml-3 cursor-pointer" aria-label={t.close}>×</button>
        </div>
        <div className="flex gap-1 px-4 pt-2 border-b border-surface0">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 text-sm rounded-t-lg transition-colors cursor-pointer ${tab === id ? 'bg-surface0 text-text' : 'text-subtext0 hover:text-text'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {tab === 'overview' && (
            <div className="space-y-4">
              <ContainerCharts history={history} />
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-overlay0 block text-xs">{t.state}</span>{container.state} {container.health && <Badge color={container.health === 'healthy' ? 'green' : 'red'}>{container.health}</Badge>}</div>
                <div><span className="text-overlay0 block text-xs">{t.restartPolicy}</span>{container.restartPolicy || '—'}</div>
                <div><span className="text-overlay0 block text-xs">Creato</span>{fmtTs(container.createdAt)}</div>
                <div><span className="text-overlay0 block text-xs">Rete</span>{container.networkMode || '—'}</div>
              </div>
              {container.ports?.length > 0 && (
                <div>
                  <div className="text-xs text-overlay0 mb-1">{t.ports}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {container.ports.map((p, i) => (
                      <Badge key={i} color="blue">{p.pub ? `${p.pub}→` : ''}{p.priv}/{p.type}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {mounts.length > 0 && (
                <div>
                  <div className="text-xs text-overlay0 mb-1">Mount</div>
                  <div className="space-y-0.5 font-mono text-[12px] text-subtext1">
                    {mounts.map((m, i) => (
                      <div key={i} className="truncate" title={`${m.Source} → ${m.Destination}`}>
                        {m.Source} → {m.Destination}{m.RW ? '' : ' (ro)'}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {env.length > 0 && (
                <details>
                  <summary className="text-xs text-overlay0 cursor-pointer hover:text-subtext0">Variabili d'ambiente ({env.length})</summary>
                  <div className="mt-1 space-y-0.5 font-mono text-[12px] text-subtext1 max-h-48 overflow-y-auto">
                    {env.map((e, i) => <div key={i} className="truncate" title={e}>{e}</div>)}
                  </div>
                </details>
              )}
              {inspect?.State?.ExitCode !== undefined && container.state === 'exited' && (
                <div className="text-sm text-red">Exit code: {inspect.State.ExitCode}</div>
              )}
            </div>
          )}
          {tab === 'logs' && <div className="h-full min-h-[400px]"><LogsPanel containerId={container.id} /></div>}
          {tab === 'console' && (
            <div className="h-full min-h-[400px]">
              <Suspense fallback={<div className="flex justify-center py-10"><Spinner className="w-6 h-6" /></div>}>
                <ExecPanel containerId={container.id} />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
