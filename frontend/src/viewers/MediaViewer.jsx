// Player audio/video nativi via /api/fs/raw (Range → seek nativo del browser).
import { rawUrl } from './registry.js';

export default function MediaViewer({ meta }) {
  return (
    <div className="h-full flex items-center justify-center p-4">
      {meta.category === 'video' ? (
        <video controls autoPlay className="max-w-full max-h-full rounded-lg" src={rawUrl(meta.path)} />
      ) : (
        <audio controls autoPlay className="w-full max-w-xl" src={rawUrl(meta.path)} />
      )}
    </div>
  );
}
