// Editor testo/codice CodeMirror 6: highlight per linguaggio (lazy), salvataggio
// atomico con X-Base-Mtime (409 su conflitto), preservazione EOL/encoding.
// File oltre 5 MB: sola lettura (mai salvare una vista parziale).
import { useEffect, useRef, useState } from 'react';
import { Btn, Spinner } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';
import { t } from '../i18n.js';
import { rawUrl } from './registry.js';

const MAX_EDIT = 5 * 1024 * 1024;
const MAX_VIEW = 20 * 1024 * 1024;

export default function TextEditor({ meta, onDirty, onFail, onSaved }) {
  const toast = useToast();
  const holderRef = useRef(null);
  const viewRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const readonly = !meta.canWrite || meta.size > MAX_EDIT;

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const [{ EditorView, keymap }, { EditorState }, { basicSetup }, { languages }] = await Promise.all([
          import('@codemirror/view'), import('@codemirror/state'), import('codemirror'), import('@codemirror/language-data'),
        ]);
        const headers = meta.size > MAX_VIEW ? { range: `bytes=0-${2 * 1024 * 1024 - 1}` } : {};
        const res = await fetch(rawUrl(meta.path), { credentials: 'same-origin', headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        const text = new TextDecoder(meta.encoding === 'latin1' ? 'latin1' : meta.encoding || 'utf-8').decode(ab);
        if (disposed) return;

        const ext = meta.name.includes('.') ? meta.name.split('.').pop().toLowerCase() : '';
        const langDesc = languages.find((l) => l.extensions?.includes(ext));
        const langExt = langDesc ? await langDesc.load() : [];

        const theme = EditorView.theme({
          '&': { backgroundColor: '#11111b', color: '#cdd6f4', height: '100%', fontSize: '13px' },
          '.cm-gutters': { backgroundColor: '#181825', color: '#585b70', border: 'none' },
          '.cm-activeLine': { backgroundColor: '#31324455' },
          '.cm-cursor': { borderLeftColor: '#f5e0dc' },
          '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: '#45475a' },
        }, { dark: true });

        viewRef.current = new EditorView({
          parent: holderRef.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              basicSetup, langExt, theme,
              EditorState.readOnly.of(readonly),
              EditorView.updateListener.of((u) => {
                if (u.docChanged) { setDirty(true); onDirty?.(true); }
              }),
              keymap.of([{ key: 'Mod-s', run: () => { save(); return true; } }]),
            ],
          }),
        });
        setReady(true);
      } catch (e) { onFail?.(e.message); }
    })();
    return () => { disposed = true; viewRef.current?.destroy(); };
  }, [meta.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (readonly || !viewRef.current) return;
    setSaving(true);
    try {
      let text = viewRef.current.state.doc.toString();
      if (meta.eol === 'crlf') text = text.replace(/\r?\n/g, '\r\n'); // EOL preservato
      let body;
      if (meta.encoding === 'latin1') {
        // Encoding preservato se rappresentabile, altrimenti chiedi UTF-8
        // eslint-disable-next-line no-control-regex
        if ([...text].some((ch) => ch.codePointAt(0) > 255)) {
          if (!window.confirm(t.textSaveUtf8)) { setSaving(false); return; }
          body = new Blob([text]);
        } else {
          body = new Blob([Uint8Array.from([...text].map((ch) => ch.codePointAt(0)))]);
        }
      } else {
        body = new Blob([meta.bom ? '﻿' + text : text]);
      }
      const res = await fetch(`/api/fs/save?path=${encodeURIComponent(meta.path)}`, {
        method: 'PUT', body, credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream', 'x-base-mtime': String(Math.round(meta.mtime)) },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      setDirty(false);
      onDirty?.(false);
      onSaved?.();
      toast.ok(t.tabFiles, t.filesSaved(meta.name));
    } catch (e) { toast.error(t.tabFiles, e.message); }
    setSaving(false);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface0 text-[11px] text-overlay0">
        {readonly
          ? <span>{meta.canWrite ? t.textTooBigRo : t.viewerReadonly}</span>
          : <span>{meta.encoding}{meta.bom ? ' +BOM' : ''} · {meta.eol.toUpperCase()} · Ctrl+S</span>}
        <div className="grow" />
        {!readonly && <Btn size="sm" variant="primary" onClick={save} disabled={!dirty || saving}>{saving ? <Spinner /> : t.filesSave}</Btn>}
      </div>
      {!ready && <div className="flex justify-center py-20"><Spinner className="w-8 h-8" /></div>}
      <div ref={holderRef} className="flex-1 min-h-0 overflow-auto" />
    </div>
  );
}
