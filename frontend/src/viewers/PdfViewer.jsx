// Viewer PDF con pdf.js — worker bundlato in locale (MAI CDN, spec §1.1).
import { useEffect, useRef, useState } from 'react';
import { Spinner, Btn } from '../components/ui.jsx';
import { rawUrl } from './registry.js';

const BATCH = 20;

export default function PdfViewer({ meta, onFail }) {
  const holderRef = useRef(null);
  const docRef = useRef(null);
  const [pages, setPages] = useState(0);
  const [rendered, setRendered] = useState(0);
  const [busy, setBusy] = useState(true);

  const renderMore = async (from, count) => {
    const doc = docRef.current;
    if (!doc) return;
    setBusy(true);
    for (let n = from + 1; n <= Math.min(from + count, doc.numPages); n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1.4 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.className = 'mx-auto mb-3 rounded shadow max-w-full h-auto';
      holderRef.current?.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
    setRendered(Math.min(from + count, doc.numPages));
    setBusy(false);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
        const doc = await pdfjs.getDocument({
          url: rawUrl(meta.path),
          cMapUrl: undefined, // asset locali di default nel bundle
        }).promise;
        if (cancelled) return;
        docRef.current = doc;
        setPages(doc.numPages);
        await renderMore(0, BATCH);
      } catch (e) { onFail?.(e.message); }
    })();
    return () => { cancelled = true; docRef.current?.destroy(); };
  }, [meta.path]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="p-4">
      <div ref={holderRef} />
      {busy && <div className="flex justify-center py-10"><Spinner className="w-8 h-8" /></div>}
      {!busy && rendered < pages && (
        <div className="flex justify-center py-3">
          <Btn size="sm" onClick={() => renderMore(rendered, BATCH)}>Pagine {rendered + 1}–{Math.min(rendered + BATCH, pages)} di {pages}</Btn>
        </div>
      )}
    </div>
  );
}
