// File manager delle share (SFTP lato backend): navigazione sotto /mnt,
// anteprima in-app per immagini/video/audio/pdf/testo, download, upload,
// nuova cartella, rinomina, elimina (dir solo se vuote).
import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { api } from '../api.js';
import { Btn, Card, Spinner, EmptyState, Badge } from '../components/ui.jsx';
import { Modal } from '../components/Modal.jsx';
import { useToast } from '../components/Toast.jsx';
import { t, fmtBytes, fmtTs } from '../i18n.js';

// Editor integrati (SheetJS/docx-preview, bundlati): lazy per non pesare sul bundle base
const SpreadsheetEditor = lazy(() => import('../components/OfficeLocal.jsx').then((m) => ({ default: m.SpreadsheetEditor })));
const DocxPanel = lazy(() => import('../components/OfficeLocal.jsx').then((m) => ({ default: m.DocxPanel })));
// Viewer universale (spec v1.2): attivo quando il file system è montato in locale
const ViewerModal = lazy(() => import('../viewers/ViewerModal.jsx').then((m) => ({ default: m.ViewerModal })));
const PdfInline = lazy(() => import('../viewers/PdfViewer.jsx'));

const TEXT_EXT = ['txt', 'md', 'log', 'conf', 'cfg', 'ini', 'yml', 'yaml', 'sh', 'py', 'js', 'ts', 'jsx', 'tsx',
  'css', 'html', 'htm', 'xml', 'svg', 'csv', 'json', 'c', 'cpp', 'cc', 'h', 'hpp', 'java', 'go', 'rs', 'php',
  'rb', 'pl', 'lua', 'sql', 'toml', 'env', 'bat', 'ps1', 'vue', 'properties', 'nfo', 'srt', 'sub', 'm3u', 'm3u8', 'cue'];
const kindFor = (name) => {
  if (!name.includes('.')) return 'unknown'; // senza estensione: detection dal contenuto
  const ext = name.split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mkv', 'mov'].includes(ext)) return 'video';
  if (['mp3', 'flac', 'wav', 'm4a', 'ogg', 'opus'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return 'document';
  if (TEXT_EXT.includes(ext)) return 'text';
  return 'unknown'; // estensione ignota: prova comunque la detection
};
const dlUrl = (p, dl = false) => `/api/unraid/files/download?path=${encodeURIComponent(p)}${dl ? '&dl=1' : ''}`;
const ICON = { dir: '📁', link: '🔗', image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', text: '📄', document: '📝', unknown: '📦' };

const OFFICE_EXT = ['doc', 'docx', 'odt', 'rtf', 'docm', 'xls', 'xlsx', 'ods', 'xlsm', 'ppt', 'pptx', 'odp', 'ppsx', 'epub', 'fb2'];
const officeSupported = (name) => name.includes('.') && OFFICE_EXT.includes(name.split('.').pop().toLowerCase());

// Editor OnlyOffice a schermo pieno: carica api.js dal Document Server e monta
// DocsAPI.DocEditor; il salvataggio torna a UnraidDeck via callback → SFTP.
function OfficeEditor({ item, onClose }) {
  const [error, setError] = useState(null);

  useEffect(() => {
    let editor = null;
    let cancelled = false;
    api.post('/unraid/office/session', { path: item.path })
      .then(({ config: cfg, apiJs }) => new Promise((resolve, reject) => {
        if (window.DocsAPI) return resolve(cfg);
        const s = document.createElement('script');
        s.src = apiJs;
        s.onload = () => resolve(cfg);
        s.onerror = () => reject(new Error(t.officeApiFail));
        document.head.appendChild(s);
      }))
      .then((cfg) => {
        if (cancelled) return;
        editor = new window.DocsAPI.DocEditor('unraiddeck-office-holder', {
          ...cfg,
          width: '100%',
          height: '100%',
          events: { onError: (e) => setError(e?.data?.errorDescription || 'Errore editor') },
        });
      })
      .catch((e) => setError(e.message));
    return () => { cancelled = true; try { editor?.destroyEditor(); } catch { /* già chiuso */ } };
  }, [item.path]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-50 bg-crust/95 flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-surface0 bg-mantle">
        <span className="text-sm font-medium truncate">{item.name}</span>
        <Btn size="sm" onClick={onClose}>{t.officeClose}</Btn>
      </div>
      {error ? (
        <div className="m-4 text-sm text-red bg-red/10 border border-red/30 rounded-lg px-3 py-2">{error}</div>
      ) : (
        <div className="flex-1 min-h-0"><div id="unraiddeck-office-holder" className="w-full h-full" /></div>
      )}
    </div>
  );
}

// Editor Collabora embedded (immagine :office): iframe same-origin via proxy
// /browser|/cool; sessione WOPI creata dal backend. Fallback → editor JS locali.
function CollaboraFrame({ item, onClose, onFallback }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    api.post('/fs/edit-session', { path: item.path })
      .then((r) => setUrl(r.iframeUrl))
      .catch(() => onFallback());
  }, [item.path]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!url) return <div className="fixed inset-0 z-50 bg-crust/95 flex items-center justify-center"><Spinner className="w-8 h-8" /></div>;
  return (
    <div className="fixed inset-0 z-50 bg-crust flex flex-col">
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-surface0 bg-mantle">
        <span className="text-sm font-medium truncate">{item.name}</span>
        <Btn size="sm" onClick={onClose}>{t.officeClose}</Btn>
      </div>
      <iframe title={item.name} src={url} className="flex-1 min-h-0 w-full border-0" allow="clipboard-read; clipboard-write" />
    </div>
  );
}

const COLLABORA_EXT = [...OFFICE_EXT, 'xlsx', 'xlsm', 'csv'];

// Link di condivisione pubblici (scadenza + password opzionali)
function ShareModal({ item, onClose }) {
  const toast = useToast();
  const [expiry, setExpiry] = useState('168');
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState(null);

  const create = async () => {
    try {
      const r = await api.post('/cloud/shares', {
        path: item.path,
        expiresHours: expiry === '0' ? null : Number(expiry),
        password: password || null,
      });
      const abs = `${window.location.origin}${r.url}`;
      setUrl(abs);
      try { await navigator.clipboard.writeText(abs); toast.ok(t.shareTitle, t.shareCopied); } catch { /* clipboard negata */ }
    } catch (e) { toast.error(t.shareTitle, e.message); }
  };

  return (
    <Modal title={`${t.shareTitle} — ${item.name}`} onClose={onClose}>
      {url ? (
        <div className="space-y-2">
          <input readOnly value={url} onFocus={(e) => e.target.select()}
            className="w-full bg-mantle border border-surface1 rounded-lg px-3 py-1.5 text-sm font-mono" />
          <div className="text-xs text-overlay0">{t.shareCopied}</div>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block">
            <span className="block text-xs text-subtext0 mb-1">{t.shareExpiry}</span>
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)}
              className="w-full bg-mantle border border-surface1 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-blue">
              <option value="24">24 ore</option>
              <option value="168">7 giorni</option>
              <option value="720">30 giorni</option>
              <option value="0">{t.shareExpiryNever}</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-xs text-subtext0 mb-1">{t.sharePassword}</span>
            <input type="text" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-mantle border border-surface1 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-blue" />
          </label>
          <div className="flex justify-end"><Btn variant="primary" onClick={create}>{t.shareCreate}</Btn></div>
        </div>
      )}
    </Modal>
  );
}

function SharesList({ onClose }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const load = () => api.get('/cloud/shares').then(setRows).catch((e) => toast.error(t.shareList, e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title={t.shareList} onClose={onClose} wide>
      {!rows ? <Spinner /> : rows.length === 0 ? <div className="text-sm text-overlay0">{t.shareNone}</div> : (
        <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
          {rows.map((s) => (
            <div key={s.token} className="flex items-center gap-2 text-xs bg-mantle border border-surface0 rounded-lg px-3 py-2">
              <div className="min-w-0 grow">
                <div className="truncate">{s.path}</div>
                <div className="text-overlay0">
                  /s/{s.token.slice(0, 10)}… · {s.downloads} {t.shareDownloads}
                  {s.exp ? ` · scade ${fmtTs(s.exp)}` : ''}{s.locked ? ' · 🔒' : ''}
                </div>
              </div>
              <Btn size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/s/${s.token}`).catch(() => {}); toast.ok(t.shareList, t.shareCopied); }}>🔗</Btn>
              <Btn size="sm" variant="danger" onClick={async () => { await api.del(`/cloud/shares/${s.token}`); load(); }}>{t.shareDelete}</Btn>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

const EDIT_MAX = 2 * 1024 * 1024;

function Preview({ item, onClose }) {
  const toast = useToast();
  const initialKind = kindFor(item.name);
  // 'unknown' viene risolto in 'text' o 'binary' dopo la peek sul contenuto
  const [kind, setKind] = useState(initialKind);
  const [text, setText] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState(null);

  const loadText = () => fetch(dlUrl(item.path), { credentials: 'same-origin' })
    .then((r) => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then((s) => { setText(s); setDirty(false); })
    .catch((e) => setText(`Errore: ${e.message}`));

  const loadExtract = () => {
    setKind('extract');
    setText(null);
    fetch(`/api/unraid/files/extract?path=${encodeURIComponent(item.path)}`, { credentials: 'same-origin' })
      .then((r) => r.json().then((j) => r.ok ? j : Promise.reject(new Error(j?.error || `HTTP ${r.status}`))))
      .then((j) => { setText(j.text || '(vuoto)'); if (j.lossy) setNote(t.filesLossyNote); })
      .catch((e) => setText(`Errore: ${e.message}`));
  };

  useEffect(() => {
    if (initialKind === 'text') {
      if (item.size > EDIT_MAX) { setKind('binary'); setNote(t.filesTooBig); return; }
      loadText();
    } else if (initialKind === 'document') {
      loadExtract();
    } else if (initialKind === 'unknown') {
      // File senza estensione (o ignota): guarda dentro
      fetch(`/api/unraid/files/peek?path=${encodeURIComponent(item.path)}`, { credentials: 'same-origin' })
        .then((r) => r.json())
        .then((j) => {
          if (j.isText && j.size <= EDIT_MAX) { setKind('text'); loadText(); }
          else { setKind('binary'); if (j.isText) setNote(t.filesTooBig); }
        })
        .catch(() => setKind('binary'));
    }
  }, [item.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/unraid/files/upload?path=${encodeURIComponent(item.path)}`, {
        method: 'PUT', body: text, credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      setDirty(false);
      toast.ok(t.tabFiles, t.filesSaved(item.name));
    } catch (e) { toast.error(t.tabFiles, e.message); }
    setSaving(false);
  };

  return (
    <Modal title={item.name + (dirty ? ' •' : '')} onClose={onClose} wide>
      <div className="max-h-[70vh] overflow-auto flex justify-center">
        {kind === 'image' && <img src={dlUrl(item.path)} alt={item.name} className="max-w-full h-auto rounded-lg" />}
        {kind === 'video' && <video controls autoPlay className="max-w-full max-h-[65vh] rounded-lg" src={dlUrl(item.path)} />}
        {kind === 'audio' && <audio controls autoPlay className="w-full" src={dlUrl(item.path)} />}
        {kind === 'pdf' && (
          <Suspense fallback={<Spinner />}>
            <div className="w-full h-[65vh] overflow-auto">
              <PdfInline meta={{ path: item.path, name: item.name }} url={dlUrl(item.path)} onFail={() => {}} />
            </div>
          </Suspense>
        )}
        {kind === 'unknown' && <Spinner />}
        {kind === 'text' && (text === null ? <Spinner /> : (
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setDirty(true); }}
            spellCheck={false}
            className="w-full h-[60vh] text-xs font-mono bg-crust text-text rounded-lg p-3 border border-surface0 outline-none focus:border-blue resize-none"
          />
        ))}
        {kind === 'extract' && (text === null ? <Spinner /> : (
          <pre className="w-full text-xs whitespace-pre-wrap break-words font-mono bg-crust rounded-lg p-3">{text}</pre>
        ))}
        {kind === 'binary' && <div className="text-sm text-subtext0 py-6">{t.filesNoPreview}</div>}
      </div>
      {note && <div className="text-[11px] text-peach mt-2">{note}</div>}
      <div className="flex justify-end items-center gap-2 mt-3">
        {kind === 'binary' && <Btn size="sm" variant="ghost" onClick={loadExtract}>{t.filesForceText}</Btn>}
        {kind === 'text' && (
          <Btn size="sm" variant="primary" onClick={save} disabled={!dirty || saving}>
            {saving ? <Spinner /> : t.filesSave}
          </Btn>
        )}
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
  const [officeDoc, setOfficeDoc] = useState(null);   // editor OnlyOffice (se configurato)
  const [collabDoc, setCollabDoc] = useState(null);   // editor Collabora embedded (:office)
  const [sheetDoc, setSheetDoc] = useState(null);     // editor fogli integrato
  const [docxDoc, setDocxDoc] = useState(null);       // viewer/editor docx integrato
  const [universal, setUniversal] = useState(null);   // viewer universale (fs locale)
  const [shareItem, setShareItem] = useState(null);
  const [sharesOpen, setSharesOpen] = useState(false);
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
            {data.localFs && <Btn size="sm" variant="ghost" onClick={() => setSharesOpen(true)}>{t.shareList}</Btn>}
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
                      onClick={() => {
                        const full = { ...e, path: `${data.path}/${e.name}` };
                        const ext = e.name.includes('.') ? e.name.split('.').pop().toLowerCase() : '';
                        if (e.type === 'dir') load(full.path);
                        else if (data.officeMode === 'collabora' && COLLABORA_EXT.includes(ext)) setCollabDoc(full);
                        else if (data.office && officeSupported(e.name)) setOfficeDoc(full);
                        else if (['xlsx', 'xls', 'ods', 'xlsm'].includes(ext)) setSheetDoc(full);
                        else if (ext === 'docx') setDocxDoc(full);
                        else if (data.localFs) setUniversal(full.path);
                        else setPreview(full);
                      }}
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
                      {data.localFs && (
                        <button onClick={() => setShareItem({ ...e, path: `${data.path}/${e.name}` })} className="text-xs text-subtext0 hover:text-blue px-1 cursor-pointer" title={t.shareTitle}>🔗</button>
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

      {shareItem && <ShareModal item={shareItem} onClose={() => setShareItem(null)} />}
      {sharesOpen && <SharesList onClose={() => setSharesOpen(false)} />}
      {preview && <Preview item={preview} onClose={() => setPreview(null)} />}
      {universal && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-crust/95 flex items-center justify-center"><Spinner className="w-8 h-8" /></div>}>
          <ViewerModal path={universal} onClose={() => { setUniversal(null); load(data.path); }} />
        </Suspense>
      )}
      {officeDoc && <OfficeEditor item={officeDoc} onClose={() => { setOfficeDoc(null); load(data.path); }} />}
      {collabDoc && (
        <CollaboraFrame
          item={collabDoc}
          onClose={() => { setCollabDoc(null); load(data.path); }}
          onFallback={() => {
            const ext = collabDoc.name.split('.').pop().toLowerCase();
            const d = collabDoc;
            setCollabDoc(null);
            if (['xlsx', 'xls', 'ods', 'xlsm', 'csv'].includes(ext)) setSheetDoc(d);
            else if (ext === 'docx') setDocxDoc(d);
            else setPreview(d);
          }}
        />
      )}
      {sheetDoc && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-crust/95 flex items-center justify-center"><Spinner className="w-8 h-8" /></div>}>
          <SpreadsheetEditor item={sheetDoc} onClose={() => { setSheetDoc(null); load(data.path); }} />
        </Suspense>
      )}
      {docxDoc && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-crust/95 flex items-center justify-center"><Spinner className="w-8 h-8" /></div>}>
          <DocxPanel item={docxDoc} onClose={() => { setDocxDoc(null); load(data.path); }} onSaved={() => load(data.path)} />
        </Suspense>
      )}
    </div>
  );
}
