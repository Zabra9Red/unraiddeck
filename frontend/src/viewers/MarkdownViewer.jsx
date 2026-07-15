// Markdown: render markdown-it sanificato con DOMPurify, toggle Preview/Raw.
import { useEffect, useState } from 'react';
import { Btn, Spinner } from '../components/ui.jsx';
import { rawUrl } from './registry.js';

export default function MarkdownViewer({ meta, onFail }) {
  const [html, setHtml] = useState(null);
  const [raw, setRaw] = useState(null);
  const [mode, setMode] = useState('preview');

  useEffect(() => {
    (async () => {
      try {
        const [{ default: MarkdownIt }, { default: DOMPurify }, res] = await Promise.all([
          import('markdown-it'), import('dompurify'),
          fetch(rawUrl(meta.path), { credentials: 'same-origin' }),
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        setRaw(text);
        setHtml(DOMPurify.sanitize(new MarkdownIt({ linkify: true }).render(text)));
      } catch (e) { onFail?.(e.message); }
    })();
  }, [meta.path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (html === null) return <div className="flex justify-center py-20"><Spinner className="w-8 h-8" /></div>;
  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-1.5 border-b border-surface0">
        <Btn size="sm" variant="ghost" onClick={() => setMode(mode === 'preview' ? 'raw' : 'preview')}>
          {mode === 'preview' ? 'Raw' : 'Preview'}
        </Btn>
      </div>
      {mode === 'preview' ? (
        <div className="flex-1 min-h-0 overflow-auto px-6 py-4 prose-invert max-w-3xl mx-auto w-full
          [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mb-2
          [&_p]:mb-2 [&_a]:text-blue [&_code]:bg-surface0 [&_code]:px-1 [&_code]:rounded
          [&_pre]:bg-crust [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:mb-2
          [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-0.5
          [&_table]:border-collapse [&_td]:border [&_td]:border-surface1 [&_td]:px-2 [&_th]:border [&_th]:border-surface1 [&_th]:px-2
          [&_blockquote]:border-l-2 [&_blockquote]:border-overlay0 [&_blockquote]:pl-3 [&_blockquote]:text-subtext0"
          // Sanificato con DOMPurify qui sopra
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="flex-1 min-h-0 overflow-auto text-xs font-mono bg-crust m-3 rounded-lg p-3 whitespace-pre-wrap">{raw}</pre>
      )}
    </div>
  );
}
