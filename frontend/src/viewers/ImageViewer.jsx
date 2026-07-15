// Viewer immagini: zoom, rotazione, fit. SVG via <img>: gli script non eseguono.
import { useState } from 'react';
import { Btn } from '../components/ui.jsx';
import { rawUrl } from './registry.js';

export default function ImageViewer({ meta, onFail }) {
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-surface0">
        <Btn size="sm" onClick={() => setZoom(Math.max(0.1, zoom / 1.5))}>−</Btn>
        <span className="text-xs text-subtext0 w-12 text-center">{Math.round(zoom * 100)}%</span>
        <Btn size="sm" onClick={() => setZoom(Math.min(16, zoom * 1.5))}>+</Btn>
        <Btn size="sm" onClick={() => setZoom(1)}>Fit</Btn>
        <Btn size="sm" onClick={() => setRot((rot + 90) % 360)}>⟳</Btn>
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4">
        <img
          src={rawUrl(meta.path)}
          alt={meta.name}
          onError={() => onFail?.('Decodifica immagine fallita')}
          style={{ transform: `scale(${zoom}) rotate(${rot}deg)`, transition: 'transform .15s' }}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    </div>
  );
}
