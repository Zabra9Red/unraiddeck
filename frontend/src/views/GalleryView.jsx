// Tab Foto: galleria timeline dalle share (thumbnail server-side con cache),
// raggruppata per mese, lightbox col viewer universale. Richiede il mount
// locale /mnt → /unraid.
import { useEffect, useState, lazy, Suspense } from 'react';
import { api } from '../api.js';
import { Btn, Card, Spinner, EmptyState, Input } from '../components/ui.jsx';
import { t } from '../i18n.js';

const ViewerModal = lazy(() => import('../viewers/ViewerModal.jsx').then((m) => ({ default: m.ViewerModal })));

const MESI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];

export function GalleryView() {
  const [dir, setDir] = useState('/unraid/user');
  const [input, setInput] = useState('/unraid/user');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api.get(`/cloud/photos?dir=${encodeURIComponent(dir)}`).then(setData).catch((e) => setError(e.message));
  }, [dir]);

  if (error) return <Card title={t.tabPhotos}><div className="text-sm text-peach bg-peach/10 border border-peach/30 rounded-lg px-3 py-2">{error}</div></Card>;
  if (!data) return <div className="flex justify-center py-20"><Spinner className="w-8 h-8" /></div>;

  // Raggruppa per mese (timeline stile Immich)
  const groups = [];
  let cur = null;
  for (const it of data.items) {
    const d = new Date(it.mtime);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!cur || cur.key !== key) {
      cur = { key, label: `${MESI[d.getMonth()]} ${d.getFullYear()}`, items: [] };
      groups.push(cur);
    }
    cur.items.push(it);
  }

  return (
    <div className="space-y-3">
      <Card title={t.tabPhotos}>
        <div className="flex items-end gap-2 flex-wrap">
          <Input label={t.photosDir} value={input} onChange={(e) => setInput(e.target.value)} className="max-w-md" />
          <Btn size="sm" variant="primary" onClick={() => setDir(input)}>{t.photosScan}</Btn>
          <span className="text-xs text-overlay0 pb-2">{data.items.length} media{data.truncated ? ` (${t.photosTruncated})` : ''}</span>
        </div>
      </Card>

      {groups.length === 0 && <Card><EmptyState>{t.photosEmpty}</EmptyState></Card>}
      {groups.map((g) => (
        <div key={g.key}>
          <div className="text-sm font-semibold text-subtext1 mb-2 px-1">{g.label}</div>
          <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 xl:grid-cols-8 gap-1.5">
            {g.items.map((it) => (
              <button
                key={it.path}
                onClick={() => setOpen(it.path)}
                className="relative aspect-square overflow-hidden rounded-lg bg-mantle border border-surface0 cursor-pointer hover:opacity-80 transition-opacity"
                title={it.name}
              >
                <img
                  src={`/api/cloud/thumb?path=${encodeURIComponent(it.path)}&kind=${it.kind}`}
                  alt={it.name}
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
                {it.kind === 'video' && <span className="absolute bottom-1 right-1 text-xs drop-shadow">▶</span>}
              </button>
            ))}
          </div>
        </div>
      ))}

      {open && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-crust/95 flex items-center justify-center"><Spinner className="w-8 h-8" /></div>}>
          <ViewerModal path={open} onClose={() => setOpen(null)} />
        </Suspense>
      )}
    </div>
  );
}
