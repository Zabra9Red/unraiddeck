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

// Gauge radiale (stile Grafana): arco 240°, colore a soglie, valore al centro.
export function GaugeArc({ value, max = 100, label, unit = '%', thresholds, size = 130 }) {
  const v = Math.max(0, Math.min(max, value ?? 0));
  const frac = v / max;
  // Soglie [{upTo, color}] valutate in ordine; default: verde fisso
  const color = (thresholds || []).find((th) => frac <= th.upTo)?.color || thresholds?.at(-1)?.color || '#a6e3a1';
  const cx = size / 2, cy = size / 2, r = size / 2 - 10;
  const a0 = -210, a1 = 30; // 240° di corsa
  const polar = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const arc = (from, to) => {
    const [x0, y0] = polar(from);
    const [x1, y1] = polar(to);
    return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
  };
  const aVal = a0 + (a1 - a0) * frac;
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size * 0.82} viewBox={`0 0 ${size} ${size * 0.82}`} role="img" aria-label={`${label}: ${value ?? '—'}${unit}`}>
        <path d={arc(a0, a1)} fill="none" stroke="#313244" strokeWidth="9" strokeLinecap="round" />
        {value != null && frac > 0.005 && (
          <path d={arc(a0, aVal)} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" />
        )}
        <text x={cx} y={cy + 2} textAnchor="middle" fontSize={size / 5.2} fontWeight="600" fill="#cdd6f4">
          {value != null ? Math.round(value) : '—'}{unit}
        </text>
        <text x={cx} y={cy + size / 5.2} textAnchor="middle" fontSize="10" fill={C.text}>{label}</text>
      </svg>
    </div>
  );
}

// Bar chart per consumi/costi periodici (stile pannello Grafana): barre kWh,
// tooltip con costo, etichette x sparse.
export function BarPanel({ title, points, valueFmt = (v) => String(v), costFmt, height = 120 }) {
  const [hover, setHover] = useState(null);
  const w = 560, h = height;
  const max = Math.max(...(points || []).map((p) => p.kwh), 0.001);
  const n = points?.length || 0;
  const step = n ? w / n : w;
  const bw = Math.max(2, step * 0.68);
  const hp = hover != null ? points[hover] : null;
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs font-medium text-subtext0">{title}</span>
        <span className="text-[11px] text-subtext0 h-4">
          {hp ? <>{hp.label}: <span className="text-text">{valueFmt(hp.kwh)}</span>{hp.cost != null && costFmt ? <span className="text-yellow"> · {costFmt(hp.cost)}</span> : null}</> : null}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full block rounded-md bg-mantle border border-surface0"
        style={{ height: h }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const idx = Math.floor(((e.clientX - rect.left) / rect.width) * n);
          setHover(Math.max(0, Math.min(n - 1, idx)));
        }}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={title}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} stroke={C.grid} strokeWidth="1" />
        ))}
        {(points || []).map((p, i) => {
          const bh = Math.max(1, (p.kwh / max) * (h - 22));
          return (
            <g key={p.label}>
              <rect
                x={i * step + (step - bw) / 2}
                y={h - 14 - bh}
                width={bw}
                height={bh}
                rx="1.5"
                fill="#f9e2af"
                opacity={hover === i ? 1 : 0.75}
              />
              {i % labelEvery === 0 && (
                <text x={i * step + step / 2} y={h - 3} textAnchor="middle" fontSize="9" fill={C.text}>{p.tick ?? p.label}</text>
              )}
            </g>
          );
        })}
        <text x="4" y="12" fontSize="10" fill={C.text}>{valueFmt(max)}</text>
      </svg>
    </div>
  );
}

export const chartColors = C;
