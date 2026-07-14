// Editor Office integrati (nessun servizio esterno): fogli di calcolo con
// SheetJS (lettura+scrittura xlsx/xls/ods/csv) e docx con anteprima fedele
// (docx-preview) + modifica a livello testo con salvataggio in un docx
// rigenerato (OOXML minimale zippato con fflate). Librerie bundlate, no CDN.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Btn, Spinner } from './ui.jsx';
import { useToast } from './Toast.jsx';
import { t } from '../i18n.js';

const dlUrl = (p) => `/api/unraid/files/download?path=${encodeURIComponent(p)}`;

async function putFile(path, body) {
  const res = await fetch(`/api/unraid/files/upload?path=${encodeURIComponent(path)}`, {
    method: 'PUT', body, credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
}

function Shell({ title, dirty, onClose, actions, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-crust/95 flex flex-col">
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-surface0 bg-mantle">
        <span className="text-sm font-medium truncate">{title}{dirty ? ' •' : ''}</span>
        <div className="flex items-center gap-2">{actions}<Btn size="sm" onClick={onClose}>{t.officeClose}</Btn></div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </div>
  );
}

// ---- Fogli di calcolo: griglia editabile, multi-sheet, salva nel formato originale ----
const MAX_ROWS = 500, MAX_COLS = 60;

// Nome colonna stile Excel: 0→A, 25→Z, 26→AA…
function colName(c) {
  let s = '';
  c += 1;
  while (c > 0) { s = String.fromCharCode(65 + (c - 1) % 26) + s; c = Math.floor((c - 1) / 26); }
  return s;
}

export function SpreadsheetEditor({ item, onClose }) {
  const toast = useToast();
  const [XLSX, setXLSX] = useState(null);
  const [wb, setWb] = useState(null);
  const [sheet, setSheet] = useState(0);
  const [aoa, setAoa] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const ext = item.name.split('.').pop().toLowerCase();

  useEffect(() => {
    Promise.all([
      import('xlsx'),
      fetch(dlUrl(item.path), { credentials: 'same-origin' }).then((r) => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))),
    ]).then(([mod, ab]) => {
      const X = mod.default || mod;
      const book = X.read(ab, { type: 'array' });
      setXLSX(X);
      setWb(book);
      setAoa(X.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true, defval: '' }));
    }).catch((e) => setError(e.message));
  }, [item.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickSheet = (i) => {
    // Salva la sheet corrente in RAM prima di cambiare
    wb.Sheets[wb.SheetNames[sheet]] = XLSX.utils.aoa_to_sheet(aoa);
    setSheet(i);
    setAoa(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1, raw: true, defval: '' }));
  };

  const setCell = (r, c, v) => {
    setAoa((prev) => {
      const next = prev.map((row) => row.slice());
      while (next.length <= r) next.push([]);
      next[r][c] = v;
      return next;
    });
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      wb.Sheets[wb.SheetNames[sheet]] = XLSX.utils.aoa_to_sheet(aoa);
      const bookType = { xlsx: 'xlsx', xlsm: 'xlsx', xls: 'xls', ods: 'ods', csv: 'csv' }[ext] || 'xlsx';
      const out = XLSX.write(wb, { type: 'array', bookType });
      await putFile(item.path, new Blob([out]));
      setDirty(false);
      toast.ok(t.tabFiles, t.filesSaved(item.name));
    } catch (e) { toast.error(t.tabFiles, e.message); }
    setSaving(false);
  };

  const rows = aoa ? Math.min(Math.max(aoa.length, 20), MAX_ROWS) : 0;
  const cols = aoa ? Math.min(Math.max(...aoa.map((r) => r.length), 8), MAX_COLS) : 0;
  const truncated = aoa && (aoa.length > MAX_ROWS || aoa.some((r) => r.length > MAX_COLS));

  return (
    <Shell
      title={item.name} dirty={dirty} onClose={onClose}
      actions={<Btn size="sm" variant="primary" onClick={save} disabled={!dirty || saving}>{saving ? <Spinner /> : t.filesSave}</Btn>}
    >
      {error && <div className="m-4 text-sm text-red bg-red/10 border border-red/30 rounded-lg px-3 py-2">{error}</div>}
      {!error && !aoa && <div className="flex justify-center py-20"><Spinner className="w-8 h-8" /></div>}
      {aoa && (
        <div className="p-3">
          {wb.SheetNames.length > 1 && (
            <div className="flex gap-1 mb-2 flex-wrap">
              {wb.SheetNames.map((n, i) => (
                <button key={n} onClick={() => pickSheet(i)}
                  className={`px-2 py-0.5 text-xs rounded-md border cursor-pointer ${i === sheet ? 'border-yellow text-yellow bg-yellow/10' : 'border-surface1 text-subtext0'}`}>
                  {n}
                </button>
              ))}
            </div>
          )}
          {truncated && <div className="text-[11px] text-peach mb-2">{t.sheetTruncated(MAX_ROWS, MAX_COLS)}</div>}
          <div className="overflow-auto border border-surface0 rounded-lg">
            <table className="border-collapse text-xs">
              <thead>
                <tr>
                  <th className="sticky top-0 left-0 z-20 bg-mantle border border-surface0 w-10" />
                  {Array.from({ length: cols }, (_, c) => (
                    <th key={c} className="sticky top-0 z-10 bg-mantle border border-surface0 px-2 py-1 text-subtext0 font-medium min-w-24">
                      {colName(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rows }, (_, r) => (
                  <tr key={r}>
                    <td className="sticky left-0 z-10 bg-mantle border border-surface0 px-2 text-center text-subtext0">{r + 1}</td>
                    {Array.from({ length: cols }, (_, c) => (
                      <td key={c} className="border border-surface0 p-0">
                        <input
                          value={aoa[r]?.[c] ?? ''}
                          onChange={(e) => setCell(r, c, e.target.value)}
                          className="w-full min-w-24 bg-transparent px-2 py-1 outline-none focus:bg-surface0/50 text-text"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-[11px] text-overlay0 mt-2">{t.sheetNote}</div>
        </div>
      )}
    </Shell>
  );
}

// ---- docx: anteprima fedele (docx-preview) + modifica testo → docx rigenerato ----
const XML_ESC = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildDocx(zipSync, text) {
  const paras = text.split('\n').map((line) =>
    `<w:p><w:r><w:t xml:space="preserve">${XML_ESC(line)}</w:t></w:r></w:p>`).join('');
  const enc = (s) => new TextEncoder().encode(s);
  return zipSync({
    '[Content_Types].xml': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`),
  });
}

export function DocxPanel({ item, onClose, onSaved }) {
  const toast = useToast();
  const holderRef = useRef(null);
  const [mode, setMode] = useState('view'); // view | edit
  const [text, setText] = useState(null);
  const [overwrite, setOverwrite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (mode !== 'view') return;
    let cancelled = false;
    Promise.all([
      import('docx-preview'),
      fetch(dlUrl(item.path), { credentials: 'same-origin' }).then((r) => r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))),
    ]).then(([dp, blob]) => {
      if (cancelled || !holderRef.current) return;
      holderRef.current.innerHTML = '';
      return dp.renderAsync(blob, holderRef.current, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: true });
    }).catch((e) => setError(e.message));
    return () => { cancelled = true; };
  }, [item.path, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = () => {
    setMode('edit');
    if (text !== null) return;
    fetch(`/api/unraid/files/extract?path=${encodeURIComponent(item.path)}`, { credentials: 'same-origin' })
      .then((r) => r.json().then((j) => r.ok ? j : Promise.reject(new Error(j?.error || `HTTP ${r.status}`))))
      .then((j) => setText(j.text || ''))
      .catch((e) => setError(e.message));
  };

  const save = async () => {
    setSaving(true);
    try {
      const { zipSync } = await import('fflate');
      const bytes = buildDocx(zipSync, text || '');
      const target = overwrite ? item.path : item.path.replace(/\.docx?$/i, '') + '-modificato.docx';
      await putFile(target, new Blob([bytes]));
      toast.ok(t.tabFiles, t.filesSaved(target.split('/').pop()));
      onSaved?.();
    } catch (e) { toast.error(t.tabFiles, e.message); }
    setSaving(false);
  };

  return (
    <Shell
      title={item.name} onClose={onClose}
      actions={mode === 'view'
        ? <Btn size="sm" onClick={startEdit}>{t.docxEdit}</Btn>
        : (
          <>
            <label className="flex items-center gap-1.5 text-xs text-subtext0 cursor-pointer">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} className="accent-[#f38ba8]" />
              {t.docxOverwrite}
            </label>
            <Btn size="sm" variant="primary" onClick={save} disabled={saving || text === null}>{saving ? <Spinner /> : t.filesSave}</Btn>
            <Btn size="sm" variant="ghost" onClick={() => setMode('view')}>{t.docxBackView}</Btn>
          </>
        )}
    >
      {error && <div className="m-4 text-sm text-red bg-red/10 border border-red/30 rounded-lg px-3 py-2">{error}</div>}
      {mode === 'view' ? (
        <div ref={holderRef} className="docx-holder min-h-full bg-[#585b70]/30 p-4 flex justify-center" />
      ) : (
        <div className="p-3 h-full flex flex-col gap-2">
          <div className="text-[11px] text-peach">{t.docxEditNote}</div>
          {text === null ? <Spinner /> : (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              className="flex-1 min-h-[60vh] w-full text-sm font-mono bg-crust text-text rounded-lg p-3 border border-surface0 outline-none focus:border-blue resize-none"
            />
          )}
        </div>
      )}
    </Shell>
  );
}
