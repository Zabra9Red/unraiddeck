// File manager delle share (SFTP lato backend): navigazione sotto /mnt,
// anteprima in-app per immagini/video/audio/pdf/testo, download, upload,
// nuova cartella, rinomina, elimina (dir solo se vuote).
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Btn, Card, Spinner, EmptyState, Badge } from '../components/ui.jsx';
import { Modal } from '../components/Modal.jsx';
import { useToast } from '../components/Toast.jsx';
import { t, fmtBytes, fmtTs } from '../i18n.js';

const kindFor = (name) => {
  const ext = name.split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mkv', 'mov'].includes(ext)) return 'video';
  if (['mp3', 'flac', 'wav', 'm4a', 'ogg', 'opus'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['txt', 'md', 'log', 'conf', 'cfg', 'ini', 'yml', 'yaml', 'sh', 'py', 'js', 'ts', 'css', 'html', 'htm', 'xml', 'svg', 'csv', 'json'].includes(ext)) return 'text';
  return 'other';
};
const dlUrl = (p, dl = false) => `/api/unraid/files/download?path=${encodeURIComponent(p)}${dl ? '&dl=1' : ''}`;
const ICON = { dir: '📁', link: '🔗', image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', text: '📄', other: '📦' };

function Preview({ item, onClose }) {
  const kind = kindFor(item.name);
  const [text, setText] = useState(null);

  useEffect(() => {
    if (kind !== 'text') return;
    if (item.size > 2 * 1024 * 1024) { setText(t.filesTooBig); return; }
    fetch(dlUrl(item.path), { credentials: 'same-origin' })
      .then((r) => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setText)
      .catch((e) => setText(`Errore: ${e.message}`));
  }, [item.path]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal title={item.name} onClose={onClose} wide>
      <div className="max-h-[70vh] overflow-auto flex justify-center">
        {kind === 'image' && <img src={dlUrl(item.path)} alt={item.name} className="max-w-full h-auto rounded-lg" />}
        {kind === 'video' && <video controls autoPlay className="max-w-full max-h-[65vh] rounded-lg" src={dlUrl(item.path)} />}
        {kind === 'audio' && <audio controls autoPlay className="w-full" src={dlUrl(item.path)} />}
        {kind === 'pdf' && <iframe title={item.name} src={dlUrl(item.path)} className="w-full h-[65vh] rounded-lg border border-surface0" />}
        {kind === 'text' && (text === null ? <Spinner /> : <pre className="w-full text-xs whitespace-pre-wrap break-words font-mono bg-crust rounded-lg p-3">{text}</pre>)}
        {kind === 'other' && <div className="text-sm text-subtext0 py-6">{t.filesNoPreview}</div>}
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <a href={dlUrl(item.path, true)} download>
          <Btn size="sm">{t.filesDownload}</Btn>
        </a>
      </div>
    </Modal>
  );
}

export function FilesView() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const uploadRef = useRef(null);

  const load = (p) => {
    setError(null);
    api.get(`/unraid/files?path=${encodeURIComponent(p)}`)
      .then(setData)
      .catch((e) => setError(e.message));
  };
  useEffect(() => { load('/mnt/user'); }, []);

  if (error && !data) {
    return <Card title={t.tabFiles}><div className="text-sm text-peach bg-peach/10 border border-peach/30 rounded-lg px-3 py-2">{error}</div></Card>;
  }
  if (!data) return <div className="flex justify-center py-20"><Spinner className="w-8 h-8" /></div>;

  const segs = data.path.split('/').filter(Boolean);
  const crumbs = segs.map((s, i) => ({ label: s, path: '/' + segs.slice(0, i + 1).join('/') }));

  const doMkdir = async () => {
    const name = prompt(t.filesNewFolderPrompt);
    if (!name) return;
    try { await api.post('/unraid/files/mkdir', { path: `${data.path}/${name}` }); load(data.path); }
    catch (e) { toast.error(t.tabFiles, e.message); }
  };
  const doRename = async (entry) => {
    const name = prompt(t.filesRenamePrompt, entry.name);
    if (!name || name === entry.name) return;
    try { await api.post('/unraid/files/rename', { from: `${data.path}/${entry.name}`, to: `${data.path}/${name}` }); load(data.path); }
    catch (e) { toast.error(t.tabFiles, e.message); }
  };
  const doDelete = async (entry) => {
    if (!window.confirm(t.filesDeleteConfirm(entry.name))) return;
    try { await api.post('/unraid/files/delete', { path: `${data.path}/${entry.name}` }); load(data.path); }
    catch (e) { toast.error(t.tabFiles, e.message); }
  };
  const doUpload = async (file) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/unraid/files/upload?path=${encodeURIComponent(`${data.path}/${file.name}`)}`, {
        method: 'PUT', body: file, credentials: 'same-origin',
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      toast.ok(t.tabFiles, `${file.name} caricato`);
      load(data.path);
    } catch (e) { toast.error(t.tabFiles, e.message); }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <Card
        title={t.tabFiles}
        right={
          <div className="flex gap-1.5">
            <Btn size="sm" onClick={doMkdir}>{t.filesNewFolder}</Btn>
            <Btn size="sm" onClick={() => uploadRef.current?.click()} disabled={busy}>{busy ? <Spinner /> : t.filesUpload}</Btn>
            <input ref={uploadRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) doUpload(f); e.target.value = ''; }} />
          </div>
        }
      >
        {/* Breadcrumb */}
        <div className="flex items-center gap-1 text-sm mb-3 flex-wrap">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-1">
              {i > 0 && <span className="text-overlay0">/</span>}
              <button
                onClick={() => load(c.path)}
                className={`hover:text-blue transition-colors cursor-pointer ${i === crumbs.length - 1 ? 'text-text font-medium' : 'text-subtext0'}`}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
        {error && <div className="text-xs text-peach bg-peach/10 border border-peach/30 rounded-lg px-2.5 py-1.5 mb-2">{error}</div>}

        {data.entries.length === 0 ? <EmptyState>{t.filesEmpty}</EmptyState> : (
          <div className="max-h-[65vh] overflow-y-auto pr-1">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-base">
                <tr className="text-xs text-subtext0">
                  <th className="text-left font-medium py-1">{t.filesName}</th>
                  <th className="text-right font-medium py-1 w-24">{t.filesSize}</th>
                  <th className="text-right font-medium py-1 w-40 hidden sm:table-cell">{t.filesModified}</th>
                  <th className="w-24" />
                </tr>
              </thead>
              <tbody>
                {segs.length > 1 && (
                  <tr className="border-t border-surface0 cursor-pointer hover:bg-surface0/40" onClick={() => load('/' + segs.slice(0, -1).join('/'))}>
                    <td className="py-1.5 text-subtext0" colSpan={4}>📁 ..</td>
                  </tr>
                )}
                {data.entries.map((e) => (
                  <tr key={e.name} className="border-t border-surface0 hover:bg-surface0/40">
                    <td
                      className="py-1.5 cursor-pointer truncate max-w-0 w-full"
                      onClick={() => e.type === 'dir' ? load(`${data.path}/${e.name}`) : setPreview({ ...e, path: `${data.path}/${e.name}` })}
                      title={e.name}
                    >
                      <span className="mr-1.5">{ICON[e.type === 'file' ? kindFor(e.name) : e.type]}</span>
                      {e.name}
                    </td>
                    <td className="py-1.5 text-right text-subtext0 whitespace-nowrap">{e.type === 'file' ? fmtBytes(e.size) : '—'}</td>
                    <td className="py-1.5 text-right text-subtext0 whitespace-nowrap hidden sm:table-cell">{e.mtime ? fmtTs(e.mtime) : '—'}</td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      {e.type === 'file' && (
                        <a href={dlUrl(`${data.path}/${e.name}`, true)} download className="text-xs text-subtext0 hover:text-blue px-1" title={t.filesDownload}>⬇</a>
                      )}
                      <button onClick={() => doRename(e)} className="text-xs text-subtext0 hover:text-yellow px-1 cursor-pointer" title={t.filesRename}>✎</button>
                      <button onClick={() => doDelete(e)} className="text-xs text-subtext0 hover:text-red px-1 cursor-pointer" title={t.filesDelete}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="text-[11px] text-overlay0 mt-2">{t.filesHint}</div>
      </Card>

      {preview && <Preview item={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
