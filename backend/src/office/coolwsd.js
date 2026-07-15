// Supervisor Collabora CODE (coolwsd) — solo nelle immagini :office dove il
// binario esiste. Child process con restart+backoff; al primo fallimento in
// fase di setup ritenta con --o:security.capabilities=false (container
// unprivilegiato). Discovery → mappa ext→urlsrc per gli editor.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { config } from '../core/config.js';
import { log } from '../core/util.js';

const BIN = '/usr/bin/coolwsd';
let proc = null;
let stopped = false;
let backoff = 2000;
let capsFallback = false;
let discovery = null; // Map ext -> urlsrc relativo (/browser/...)

export function coolwsdAvailable() {
  return fs.existsSync(BIN) && config.officeEditor !== 'off';
}
export function collaboraReady() {
  return Boolean(discovery);
}
export function editUrlFor(ext) {
  return discovery?.get(String(ext).toLowerCase()) || null;
}

export function startCoolwsd() {
  if (!coolwsdAvailable() || stopped) return;
  const args = [
    '--o:ssl.enable=false',
    '--o:ssl.termination=true',
    '--o:net.listen=127.0.0.1',
    '--o:storage.wopi.host=127\\.0\\.0\\.1',
    '--o:net.post_allow.host=127.0.0.1',
    '--o:logging.level=warning',
  ];
  if (capsFallback) args.push('--o:security.capabilities=false');
  log.info(`[collabora] avvio coolwsd${capsFallback ? ' (senza capabilities)' : ''}…`);
  proc = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => { const s = String(d).trim(); if (/ERR|FTL/.test(s)) log.warn('[coolwsd]', s.slice(0, 300)); });
  proc.on('exit', (code) => {
    proc = null;
    if (stopped) return;
    if (!discovery && !capsFallback) {
      // Morto in fase di setup: probabile jail non inizializzabile → fallback
      capsFallback = true;
      log.warn('[collabora] coolwsd morto in setup: retry senza capabilities');
      return setTimeout(startCoolwsd, 2000);
    }
    log.warn(`[collabora] coolwsd uscito (code ${code}), restart tra ${Math.round(backoff / 1000)}s`);
    setTimeout(startCoolwsd, backoff);
    backoff = Math.min(backoff * 2, 60000);
  });
  pollDiscovery();
}

async function pollDiscovery() {
  for (let i = 0; i < 60; i++) {
    if (stopped || !proc) return;
    try {
      const res = await fetch('http://127.0.0.1:9980/hosting/discovery', { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const xml = await res.text();
        const map = new Map();
        // <action name="edit|view" ext="docx" urlsrc="http://127.0.0.1:9980/browser/<hash>/cool.html?"/>
        for (const m of xml.matchAll(/<action[^>]*name="(edit|view|view_comment)"[^>]*ext="([^"]+)"[^>]*urlsrc="([^"]+)"/g)) {
          const [, action, ext, urlsrc] = m;
          const rel = urlsrc.replace(/^https?:\/\/[^/]+/, ''); // same-origin via proxy
          if (!map.has(ext) || action === 'edit') map.set(ext, rel);
        }
        for (const m of xml.matchAll(/<action[^>]*ext="([^"]+)"[^>]*name="(edit|view)"[^>]*urlsrc="([^"]+)"/g)) {
          const [, ext, action, urlsrc] = m;
          const rel = urlsrc.replace(/^https?:\/\/[^/]+/, '');
          if (!map.has(ext) || action === 'edit') map.set(ext, rel);
        }
        discovery = map;
        backoff = 2000;
        log.info(`[collabora] pronto: ${map.size} formati editabili/visualizzabili`);
        return;
      }
    } catch { /* non ancora su */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log.warn('[collabora] discovery non raggiungibile dopo 2 minuti');
}

export function stopCoolwsd() {
  stopped = true;
  try { proc?.kill('SIGTERM'); } catch { /* già morto */ }
}
