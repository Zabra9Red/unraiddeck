// Primitive UI riusabili (Catppuccin Mocha).
import { useEffect, useRef } from 'react';

export function Btn({ children, variant = 'default', size = 'md', className = '', ...props }) {
  const variants = {
    default: 'bg-surface0 hover:bg-surface1 text-text',
    primary: 'bg-blue/90 hover:bg-blue text-crust font-medium',
    danger: 'bg-red/90 hover:bg-red text-crust font-medium',
    warn: 'bg-peach/90 hover:bg-peach text-crust font-medium',
    ghost: 'bg-transparent hover:bg-surface0 text-subtext0 hover:text-text',
    green: 'bg-green/90 hover:bg-green text-crust font-medium',
  };
  const sizes = { sm: 'px-2 py-1 text-xs rounded-md', md: 'px-3 py-1.5 text-sm rounded-lg', lg: 'px-4 py-2 text-base rounded-lg' };
  return (
    <button
      className={`inline-flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Badge({ children, color = 'surface1', title }) {
  // color: nome token catppuccin
  const map = {
    green: 'bg-green/15 text-green border-green/30',
    red: 'bg-red/15 text-red border-red/30',
    yellow: 'bg-yellow/15 text-yellow border-yellow/30',
    blue: 'bg-blue/15 text-blue border-blue/30',
    mauve: 'bg-mauve/15 text-mauve border-mauve/30',
    peach: 'bg-peach/15 text-peach border-peach/30',
    teal: 'bg-teal/15 text-teal border-teal/30',
    overlay: 'bg-surface1/40 text-subtext0 border-surface2/50',
    surface1: 'bg-surface1/60 text-subtext1 border-surface2/50',
  };
  return (
    <span title={title} className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] leading-none border whitespace-nowrap ${map[color] || map.surface1}`}>
      {children}
    </span>
  );
}

export function Card({ title, right, children, className = '' }) {
  return (
    <div className={`bg-base border border-surface0 rounded-xl ${className}`}>
      {(title || right) && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-surface0">
          <h3 className="text-sm font-semibold text-subtext1">{title}</h3>
          <div className="flex items-center gap-2">{right}</div>
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

export function Input({ label, className = '', ...props }) {
  return (
    <label className="block">
      {label && <span className="block text-xs text-subtext0 mb-1">{label}</span>}
      <input
        className={`w-full bg-mantle border border-surface1 rounded-lg px-3 py-1.5 text-sm text-text placeholder-overlay0 outline-none focus:border-blue transition-colors ${className}`}
        {...props}
      />
    </label>
  );
}

export function Spinner({ className = 'w-4 h-4' }) {
  return (
    <svg className={`animate-spin text-blue ${className}`} viewBox="0 0 24 24" fill="none" aria-label="caricamento">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function EmptyState({ children }) {
  return <div className="text-center text-overlay0 text-sm py-10">{children}</div>;
}

// Progress bar orizzontale con soglie colore.
export function Meter({ value, max = 100, color = 'blue', className = '' }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const colors = { blue: 'bg-blue', green: 'bg-green', peach: 'bg-peach', red: 'bg-red', yellow: 'bg-yellow', mauve: 'bg-mauve' };
  return (
    <div className={`h-1.5 rounded-full bg-surface0 overflow-hidden ${className}`} role="meter" aria-valuenow={value} aria-valuemax={max}>
      <div className={`h-full rounded-full transition-[width] duration-300 ${colors[color] || colors.blue}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// Menu a tendina minimale (chiude su click esterno).
export function Dropdown({ button, children, align = 'right', open, setOpen }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open, setOpen]);
  return (
    <div className="relative" ref={ref}>
      {button}
      {open && (
        <div className={`absolute z-40 mt-1 min-w-44 bg-mantle border border-surface1 rounded-lg shadow-xl shadow-crust/60 py-1 ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, danger, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-left px-3 py-1.5 text-sm transition-colors disabled:opacity-40 cursor-pointer ${danger ? 'text-red hover:bg-red/10' : 'text-text hover:bg-surface0'}`}
    >
      {children}
    </button>
  );
}
