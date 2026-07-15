// Registry viewer/editor (spec §3.1): ogni modulo dichiara match(meta) → 0=no,
// >0=priorità. text e hex matchano SEMPRE (garanzia "nessun file non apribile").
// Ogni Component è lazy → un chunk Vite per viewer.
import { lazy } from 'react';

export const VIEWERS = [
  {
    id: 'image', label: 'Immagine', kind: 'view',
    match: (m) => m.category === 'image' ? 100 : 0,
    Component: lazy(() => import('./ImageViewer.jsx')),
  },
  {
    id: 'media', label: 'Player', kind: 'view',
    match: (m) => m.category === 'video' || m.category === 'audio' ? 100 : 0,
    Component: lazy(() => import('./MediaViewer.jsx')),
  },
  {
    id: 'pdf', label: 'PDF', kind: 'view',
    match: (m) => m.category === 'pdf' ? 100 : 0,
    Component: lazy(() => import('./PdfViewer.jsx')),
  },
  {
    id: 'markdown', label: 'Markdown', kind: 'view',
    match: (m) => /\.(md|markdown)$/i.test(m.name) ? 110 : 0,
    Component: lazy(() => import('./MarkdownViewer.jsx')),
  },
  {
    id: 'json', label: 'JSON tree', kind: 'view',
    match: (m) => /\.json$/i.test(m.name) && m.size < 5 * 1024 * 1024 ? 105 : 0,
    Component: lazy(() => import('./JsonViewer.jsx')),
  },
  {
    id: 'text', label: 'Testo', kind: 'edit',
    match: (m) => m.isText ? 50 : 1, // matcha sempre (priorità minima sui binari)
    Component: lazy(() => import('./TextEditor.jsx')),
  },
  {
    id: 'hex', label: 'Hex', kind: 'view',
    match: () => 0.5, // fallback universale
    Component: lazy(() => import('./HexViewer.jsx')),
  },
];

// Ordina i viewer compatibili per priorità decrescente.
export function viewersFor(meta) {
  return VIEWERS
    .map((v) => ({ v, p: v.match(meta) }))
    .filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p)
    .map((x) => x.v);
}

export const rawUrl = (p, dl = false) => `/api/fs/raw?path=${encodeURIComponent(p)}${dl ? '&dl=1' : ''}`;
