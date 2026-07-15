// JSON tree-view espandibile (con fallback raw se il parse fallisce).
import { useEffect, useState } from 'react';
import { Spinner } from '../components/ui.jsx';
import { rawUrl } from './registry.js';

function Node({ k, v, depth }) {
  const [open, setOpen] = useState(depth < 2);
  const key = k !== undefined ? <span className="text-blue">{JSON.stringify(k)}: </span> : null;
  if (v === null || typeof v !== 'object') {
    const cls = typeof v === 'string' ? 'text-green' : typeof v === 'number' ? 'text-peach' : 'text-mauve';
    return <div style={{ paddingLeft: depth * 16 }}>{key}<span className={cls}>{JSON.stringify(v)}</span></div>;
  }
  const isArr = Array.isArray(v);
  const entries = isArr ? v.map((x, i) => [i, x]) : Object.entries(v);
  return (
    <div>
      <div style={{ paddingLeft: depth * 16 }} className="cursor-pointer select-none" onClick={() => setOpen(!open)}>
        <span className="text-overlay0">{open ? '▾' : '▸'} </span>{key}
        <span className="text-subtext0">{isArr ? `[${v.length}]` : `{${entries.length}}`}</span>
      </div>
      {open && entries.map(([ck, cv]) => <Node key={ck} k={isArr ? undefined : ck} v={cv} depth={depth + 1} />)}
    </div>
  );
}

export default function JsonViewer({ meta, onFail }) {
  const [data, setData] = useState(undefined);
  useEffect(() => {
    fetch(rawUrl(meta.path), { credentials: 'same-origin' })
      .then((r) => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((tx) => setData(JSON.parse(tx)))
      .catch((e) => onFail?.(`JSON non valido: ${e.message}`));
  }, [meta.path]); // eslint-disable-line react-hooks/exhaustive-deps
  if (data === undefined) return <div className="flex justify-center py-20"><Spinner className="w-8 h-8" /></div>;
  return <div className="p-4 text-xs font-mono overflow-auto"><Node v={data} depth={0} /></div>;
}
