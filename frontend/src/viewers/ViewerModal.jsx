// Modal fullscreen viewer/editor universale (spec §17): inspect → viewer di
// default + «Apri con…», errori con fallback testo/hex (mai vicolo cieco),
// versioni, download. I viewer sono chunk lazy dal registry.
import { useEffect, useState, Suspense } from 'react';
import { api } from '../api.js';
import { Btn, Spinner, Badge } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';
import { t, fmtBytes, fmtTs } from '../i18n.js';
import { viewersFor, VIEWERS, rawUrl } from './registry.js';

export function ViewerModal({ path, onClose }) {
  const toast = useToast();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [viewerId, setViewerId] = useState(null);
  const [openWith, setOpenWith] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [versions, setVersions] = useState(null); // null = pannello chiuso
  const [sensOk, setSensOk] = useState(false);

  useEffect(() => {
    api.get(`/fs/inspect?path=${encodeURIComponent(path)}`)
      .then((m) => { setMeta(m); setViewerId(viewersFor(m)[0]?.id || 'hex'); })
      .catch((e) => setError(e.message));
  }, [path]);

  const close = () => {
    if (dirty && !window.confirm(t.viewerDirtyConfirm)) return;
    onClose();
  };
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadVersions = async () => {
    if (versions) return setVersions(null);
    try { setVersions(await api.get(`/fs/versions?path=${encodeURIComponent(path)}`)); }
    catch (e) { toast.error(t.tabFiles, e.message); }
  };
  const restore = async (ts) => {
    if (!window.confirm(t.versionRestoreConfirm(fmtTs(ts)))) return;
    try {
      await api.post('/fs/versions/restore', { path, ts });
      toast.ok(t.tabFiles, t.versionRestored);
      setVersions(null);
      setMeta(null);
      api.get(`/fs/inspect?path=${encodeURIComponent(path)}`).then(setMeta);
    } catch (e) { toast.error(t.tabFiles, e.message); }
  };

  const active = VIEWERS.find((v) => v.id === viewerId);
  const compat = meta ? viewersFor(meta) : [];

  return (
    <div className="fixed inset-0 z-50 bg-crust/95 flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-surface0 bg-mantle flex-wrap">
        <span className="text-sm font-medium truncate max-w-[40vw]">{meta?.name || path.split('/').pop()}{dirty ? ' •' : ''}</span>
        {meta && <span className="text-[11px] text-overlay0">{fmtBytes(meta.size)} · {meta.mime}</span>}
        {meta && !meta.canWrite && <Badge color="overlay">{t.viewerReadonly}</Badge>}
        <div className="grow" />
        <div className="relative">
          <Btn size="sm" variant="ghost" onClick={() => setOpenWith(!openWith)}>{t.viewerOpenWith} ▾</Btn>
          {openWith && (
            <div className="absolute right-0 top-full mt-1 z-10 bg-mantle border border-surface1 rounded-lg shadow-xl py-1 min-w-36">
              {compat.map((v) => (
                <button key={v.id}
                  onClick={() => { setViewerId(v.id); setOpenWith(false); setError(null); }}
                  className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-surface0 cursor-pointer ${v.id === viewerId ? 'text-yellow' : ''}`}>
                  {v.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <Btn size="sm" variant="ghost" onClick={loadVersions}>{t.viewerVersions}</Btn>
        <a href={rawUrl(path, true)} download><Btn size="sm">{t.filesDownload}</Btn></a>
        <Btn size="sm" onClick={close}>✕</Btn>
      </div>

      {versions && (
        <div className="px-4 py-2 border-b border-surface0 bg-mantle/60 text-xs flex gap-2 flex-wrap items-center">
          <span className="text-subtext0">{t.viewerVersions}:</span>
          {versions.length === 0 && <span className="text-overlay0">{t.versionsNone}</span>}
          {versions.map((v) => (
            <button key={v.ts} onClick={() => restore(v.ts)}
              className="px-2 py-0.5 rounded-md border border-surface1 hover:border-yellow cursor-pointer" title={t.versionRestore}>
              {fmtTs(v.ts)} · {fmtBytes(v.size)}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {error && (
          <div className="m-4 space-y-2">
            <div className="text-sm text-red bg-red/10 border border-red/30 rounded-lg px-3 py-2">{error}</div>
            <div className="flex gap-2">
              <Btn size="sm" onClick={() => { setError(null); setViewerId('text'); }}>{t.filesForceText}</Btn>
              <Btn size="sm" onClick={() => { setError(null); setViewerId('hex'); }}>Hex</Btn>
            </div>
          </div>
        )}
        {!error && !meta && <div className="flex justify-center py-20"><Spinner className="w-8 h-8" /></div>}
        {!error && meta?.sensitive && !sensOk ? (
          <div className="m-6 max-w-lg mx-auto text-center space-y-3">
            <div className="text-peach text-sm">{t.sensitiveWarn}</div>
            <Btn size="sm" variant="warn" onClick={() => setSensOk(true)}>{t.sensitiveOpen}</Btn>
          </div>
        ) : !error && meta && active && (
          <Suspense fallback={<div className="flex justify-center py-20"><Spinner className="w-8 h-8" /></div>}>
            <active.Component
              meta={meta}
              onDirty={setDirty}
              onFail={(msg) => setError(msg)}
              onSaved={() => { setDirty(false); api.get(`/fs/inspect?path=${encodeURIComponent(path)}`).then(setMeta).catch(() => {}); }}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
