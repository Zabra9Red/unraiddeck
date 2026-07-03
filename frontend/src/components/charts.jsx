// Grafici SVG senza dipendenze. Regole: 2px line, griglia recessiva, un solo
// asse per pannello (small multiples, mai dual-axis), etichette in token testo,
// crosshair+tooltip su hover, colori fissi per metrica (mai riassegnati).
import { useMemo, useRef, useState } from 'react';
import { fmtBytes, fmtRate } from '../i18n.js';

const C = {
  cpu: '#89b4fa',   // blue — CPU ovunque
  ram: '#a6e3a1',   // green — RAM ovunque
  rx: '#89b4fa',    // blue — rete RX
  tx: '#fab387',    // peach — rete TX (coppia CVD-safe ΔE≈67, + direct label)
  grid: '#313244',
  text: '#a6adc8',
};

function buildPath(points, w, h, min, max, key) {
  if (points.length < 2) return { line: '', area: '' };
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const xy = points.map((p, i) => [i * step, h - ((p[key] ?? 0) - min) / span * (h - 2) - 1]);
  const line = 'M' + xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L');
  const area = `${line}L${w},${h}L0,${h}Z`;
  return { line, area };
}

// Sparkline di riga (una serie, nessuna legenda: il titolo di colonna la nomina).
export function Sparkline({ points, dataKey = 'cpu', max: fixedMax, width = 96, height = 28, color = C.cpu }) {
  const { line, area } = useMemo(() => {
    if (!points || points.length < 2) return { line: '', area: '' };
    const vals = points.map((p) => p[dataKey] ?? 0);
    const max = fixedMax ?? Math.max(...vals, 1);
    return buildPath(points, width, height, 0, max, dataKey);
  }, [points, dataKey, fixedMax, width, height]);
  if (!line) return <svg width={width} height={height} aria-hidden="true" />;
  return (
    <svg width={width} height={height} className="block" aria-hidden="true">
      <path d={area} fill={color} opacity="0.12" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// Pannello area singola metrica con crosshair + tooltip.
// series: [{key, color, label, fmt}] (1-2 serie della STESSA scala, es. rx/tx)
export function AreaPanel({ title, points, series, maxHint, unitFmt = (v) => String(v), height = 110 }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null); // indice punto
  const w = 560, h = height;

  const { max, paths } = useMemo(() => {
    const vals = [];
    for (const s of series) for (const p of points || []) vals.push(p[s.key] ?? 0);
    const max = Math.max(maxHint ?? 0, ...vals, 1);
    const paths = series.map((s) => ({ ...s, ...buildPath(points || [], w, h, 0, max, s.key) }));
    return { max, paths };
  }, [points, series, maxHint, h]);

  const onMove = (e) => {
    if (!ref.current || !points?.length) return;
    const rect = ref.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * w;
    const idx = Math.round((x / w) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, idx)));
  };

  const hoverX = hover != null && points?.length > 1 ? (hover / (points.length - 1)) * w : null;
  const hp = hover != null ? points?.[hover] : null;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs font-medium text-subtext0">{title}</span>
        {/* Direct label per serie: identità mai affidata al solo colore */}
        <span className="flex gap-3 text-[11px] text-subtext0">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1">
              <span className="w-2.5 h-0.5 rounded" style={{ background: s.color }} aria-hidden="true" />
              {s.label}{hp ? `: ${unitFmt(hp[s.key] ?? 0)}` : ''}
            </span>
          ))}
        </span>
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${w} ${h}`}
        className="w-full block rounded-md bg-mantle border border-surface0"
        style={{ height: h }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={title}
      >
        {/* griglia recessiva: 3 linee orizzontali */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} stroke={C.grid} strokeWidth="1" />
        ))}
        {paths.map((p) => (
          <g key={p.key}>
            {series.length === 1 && <path d={p.area} fill={p.color} opacity="0.15" />}
            <path d={p.line} fill="none" stroke={p.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}
        {hoverX != null && (
          <g>
            <line x1={hoverX} x2={hoverX} y1="0" y2={h} stroke="#585b70" strokeWidth="1" strokeDasharray="3,3" />
            {paths.map((p) => {
              const span = max || 1;
              const y = h - ((hp?.[p.key] ?? 0) / span) * (h - 2) - 1;
              return <circle key={p.key} cx={hoverX} cy={y} r="3.5" fill={p.color} stroke="#1e1e2e" strokeWidth="2" />;
            })}
          </g>
        )}
        <text x="4" y="12" fontSize="10" fill={C.text}>{unitFmt(max)}</text>
      </svg>
    </div>
  );
}

// Set di pannelli per il drawer container: CPU, RAM, Rete (small multiples).
export function ContainerCharts({ history }) {
  return (
    <div className="flex flex-col gap-3">
      <AreaPanel
        title="CPU %"
        points={history}
        series={[{ key: 'cpu', color: C.cpu, label: 'CPU' }]}
        maxHint={100}
        unitFmt={(v) => `${Math.round(v)}%`}
      />
      <AreaPanel
        title="RAM"
        points={history}
        series={[{ key: 'mem', color: C.ram, label: 'RAM' }]}
        maxHint={history?.[history.length - 1]?.memLimit || 0}
        unitFmt={fmtBytes}
      />
      <AreaPanel
        title="Rete"
        points={history}
        series={[
          { key: 'rx', color: C.rx, label: 'RX' },
          { key: 'tx', color: C.tx, label: 'TX' },
        ]}
        unitFmt={fmtRate}
      />
    </div>
  );
}

export const chartColors = C;
