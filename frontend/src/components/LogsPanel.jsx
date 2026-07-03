// Viewer log: stream via room logs:<id>, ricerca/highlight client-side,
// pausa autoscroll, download in streaming dal server.
import { useEffect, useMemo, useRef, useState } from 'react';
import { getSocket, subscribe } from '../socket.js';
import { Btn, Input } from './ui.jsx';
import { t } from '../i18n.js';

const MAX_LINES = 5000;

export function LogsPanel({ containerId }) {
  const [lines, setLines] = useState([]);
  const [query, setQuery] = useState('');
  const [paused, setPaused] = useState(false);
  const boxRef = useRef(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    setLines([]);
    const s = getSocket();
    const unsub = subscribe(`logs:${containerId}`);
    const onData = (msg) => {
      if (msg.id !== containerId) return;
      setLines((prev) => {
        const next = prev.concat(msg.chunks);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };
    const onEnd = (msg) => {
      if (msg.id !== containerId) return;
      setLines((prev) => prev.concat([[2, '--- stream terminato ---']]));
    };
    s.on('logs:data', onData);
    s.on('logs:end', onEnd);
    return () => { s.off('logs:data', onData); s.off('logs:end', onEnd); unsub(); };
  }, [containerId]);

  useEffect(() => {
    if (!pausedRef.current && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [lines]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => (q ? lines.filter(([, text]) => text.toLowerCase().includes(q)) : lines), [lines, q]);

  const renderLine = (text) => {
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q);
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark>{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0 gap-2">
      <div className="flex gap-2 items-center">
        <Input placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} className="!py-1" />
        <Btn size="sm" variant={paused ? 'warn' : 'default'} onClick={() => setPaused(!paused)}>
          {paused ? t.logsResume : t.logsPause}
        </Btn>
        <a href={`/api/containers/${containerId}/logs/download`} download>
          <Btn size="sm">{t.logsDownload}</Btn>
        </a>
      </div>
      <div
        ref={boxRef}
        onWheel={() => setPaused(true)}
        className="flex-1 min-h-0 overflow-auto bg-crust border border-surface0 rounded-lg p-2 font-mono text-[12px] leading-[1.35] whitespace-pre-wrap break-all"
      >
        {visible.map(([src, text], i) => (
          <div key={i} className={src === 2 ? 'text-red/90' : 'text-subtext1'}>{renderLine(text)}</div>
        ))}
        {!visible.length && <div className="text-overlay0">…</div>}
      </div>
    </div>
  );
}
