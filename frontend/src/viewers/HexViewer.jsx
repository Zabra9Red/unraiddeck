// Hex viewer universale (fallback finale): finestre da 64 KB via Range su
// /api/fs/raw, offset+hex+ascii, navigazione pagine e goto-offset.
import { useEffect, useState } from 'react';
import { Btn, Spinner } from '../components/ui.jsx';
import { rawUrl } from './registry.js';

const WIN = 64 * 1024;

export default function HexViewer({ meta, onFail }) {
  const [off, setOff] = useState(0);
  const [buf, setBuf] = useState(null);
  const [goto_, setGoto] = useState('');

  useEffect(() => {
    setBuf(null);
    const end = Math.min(off + WIN, meta.size) - 1;
    if (meta.size === 0) { setBuf(new Uint8Array(0)); return; }
    fetch(rawUrl(meta.path), { credentials: 'same-origin', headers: { range: `bytes=${off}-${end}` } })
      .then((r) => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((ab) => setBuf(new Uint8Array(ab)))
      .catch((e) => onFail?.(e.message));
  }, [meta.path, off]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = [];
  if (buf) {
    for (let i = 0; i < buf.length; i += 16) {
      const slice = buf.subarray(i, i + 16);
      const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const ascii = [...slice].map((b) => b >= 32 && b < 127 ? String.fromCharCode(b) : '·').join('');
      rows.push(
        `${(off + i).toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
    }
  }

  const doGoto = () => {
    const v = goto_.startsWith('0x') ? parseInt(goto_, 16) : parseInt(goto_, 10);
    if (Number.isFinite(v)) setOff(Math.max(0, Math.min(v, Math.max(0, meta.size - 1))) & ~15);
  };

  return (
    <div className="p-3 h-full flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <Btn size="sm" onClick={() => setOff(Math.max(0, off - WIN))} disabled={off === 0}>◀</Btn>
        <span className="text-subtext0 font-mono">0x{off.toString(16)} – 0x{Math.min(off + WIN, meta.size).toString(16)} / 0x{meta.size.toString(16)}</span>
        <Btn size="sm" onClick={() => setOff(off + WIN)} disabled={off + WIN >= meta.size}>▶</Btn>
        <input
          value={goto_} onChange={(e) => setGoto(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doGoto()}
          placeholder="goto (dec o 0x…)"
          className="bg-mantle border border-surface1 rounded-md px-2 py-1 text-xs font-mono w-36 outline-none focus:border-blue"
        />
      </div>
      {buf === null
        ? <div className="flex justify-center py-20"><Spinner className="w-8 h-8" /></div>
        : <pre className="flex-1 min-h-0 overflow-auto text-[11px] leading-relaxed font-mono bg-crust rounded-lg p-3 whitespace-pre">{rows.join('\n') || '(file vuoto)'}</pre>}
    </div>
  );
}
