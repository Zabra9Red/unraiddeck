// Console exec: xterm.js con resize TTY, base64 su socket.io, cleanup su unmount.
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getSocket } from '../socket.js';
import { t } from '../i18n.js';

const MOCHA_THEME = {
  background: '#11111b', foreground: '#cdd6f4', cursor: '#f5e0dc',
  black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
  blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
  brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5', brightWhite: '#a6adc8',
};

const enc = new TextEncoder();
function toB64(str) {
  const bytes = enc.encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Pannello terminale generico: prefix = namespace eventi socket
// ('exec' per la console container, 'hostterm' per la shell SSH dell'host).
export function TerminalPanel({ prefix, payload = {} }) {
  const holderRef = useRef(null);
  const [error, setError] = useState(null);
  const [ended, setEnded] = useState(null);

  useEffect(() => {
    const s = getSocket();
    const term = new Terminal({ theme: MOCHA_THEME, fontSize: 13, cursorBlink: true, convertEol: false, fontFamily: 'ui-monospace, Menlo, Consolas, monospace' });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(holderRef.current);
    fit.fit();

    let sid = null;
    let disposed = false;

    const onData = (msg) => { if (msg.sid === sid) term.write(fromB64(msg.data)); };
    const onEnd = (msg) => { if (msg.sid === sid) setEnded(msg.reason || 'Sessione terminata'); };
    s.on(`${prefix}:data`, onData);
    s.on(`${prefix}:end`, onEnd);

    s.emit(`${prefix}:start`, { ...payload, cols: term.cols, rows: term.rows }, (res) => {
      if (disposed) return;
      if (res?.error) { setError(res.error); return; }
      sid = res.sid;
      s.emit(`${prefix}:resize`, { sid, cols: term.cols, rows: term.rows });
      term.focus();
    });

    const inputDisp = term.onData((data) => { if (sid) s.emit(`${prefix}:input`, { sid, data: toB64(data) }); });
    const resizeDisp = term.onResize(({ cols, rows }) => { if (sid) s.emit(`${prefix}:resize`, { sid, cols, rows }); });
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* smontato */ } });
    ro.observe(holderRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      inputDisp.dispose();
      resizeDisp.dispose();
      s.off(`${prefix}:data`, onData);
      s.off(`${prefix}:end`, onEnd);
      if (sid) s.emit(`${prefix}:close`, { sid });
      term.dispose();
    };
    // payload serializzato: le identità degli oggetti inline non devono riavviare la sessione
  }, [prefix, JSON.stringify(payload)]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full min-h-0 gap-2">
      <div className="text-xs text-overlay0">{t.execHint}</div>
      {error && <div className="text-sm text-red bg-red/10 border border-red/30 rounded-lg px-3 py-2">{error}</div>}
      {ended && <div className="text-sm text-peach bg-peach/10 border border-peach/30 rounded-lg px-3 py-2">{ended}</div>}
      <div ref={holderRef} className="flex-1 min-h-0 rounded-lg overflow-hidden border border-surface0 bg-crust p-1" />
    </div>
  );
}

export function ExecPanel({ containerId }) {
  return <TerminalPanel prefix="exec" payload={{ containerId }} />;
}

export function HostTermPanel() {
  return <TerminalPanel prefix="hostterm" />;
}
