// Notifiche in-app (persistite in SQLite) + webhook opzionale.
// Isteresi gestita dai chiamanti (soglia-3 °C); qui cooldown max 1 notifica/h
// per chiave evento e retention 90 gg.
import { db, getSetting } from './db.js';
import { config } from './config.js';
import { log } from './util.js';

let ioRef = null;
export function bindNotifyIo(io) { ioRef = io; }

const COOLDOWN_MS = 3600000; // max 1/h per chiave

// Emette una notifica (rispettando il cooldown per chiave; opts.force lo salta
// per eventi puntuali come inizio/fine update). Ritorna true se emessa.
export function notify(key, severity, title, body = '', opts = {}) {
  const now = Date.now();
  const st = db.prepare('SELECT * FROM notif_state WHERE key = ?').get(key);
  if (!opts.force && st && now - st.last_sent < COOLDOWN_MS) return false;
  db.prepare('INSERT INTO notif_state (key, active, last_sent) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET last_sent = ?, active = 1')
    .run(key, now, now);
  const info = db.prepare('INSERT INTO notifications (ts, key, severity, title, body) VALUES (?, ?, ?, ?, ?)')
    .run(now, key, severity, title, body);
  const notif = { id: info.lastInsertRowid, ts: now, key, severity, title, body, read: 0 };
  ioRef?.to('notify').emit('notify:new', notif);
  sendWebhook(notif).catch(e => log.warn('[notify] webhook fallito:', e.message));
  return true;
}

// Stato allarme per isteresi (es. temperatura disco): i chiamanti segnano attivo/rientrato.
export function alarmActive(key) {
  const st = db.prepare('SELECT active FROM notif_state WHERE key = ?').get(key);
  return Boolean(st?.active);
}
export function alarmClear(key) {
  db.prepare('UPDATE notif_state SET active = 0 WHERE key = ?').run(key);
}

// Webhook: per ntfy (hostname "ntfy*" o NOTIFY_WEBHOOK_TYPE=ntfy) usa il
// formato nativo (testo + header X-Title/X-Priority), così la notifica su
// iPhone/Android è pulita; per il resto POST JSON compatibile Gotify/Discord.
async function sendWebhook(notif) {
  const url = config.notifyWebhookUrl;
  if (!url) return;
  const priority = { info: 3, warning: 4, error: 5 }[notif.severity] ?? 3;
  const isNtfy = config.notifyWebhookType === 'ntfy'
    || (config.notifyWebhookType !== 'json' && /(^|\.)ntfy\./i.test(new URL(url).hostname));
  let headers, body;
  if (isNtfy) {
    headers = {
      'content-type': 'text/plain; charset=utf-8',
      'x-title': `UnraidDeck: ${notif.title}`,
      'x-priority': String(priority),
      'x-tags': notif.severity === 'error' ? 'rotating_light' : notif.severity === 'warning' ? 'warning' : 'information_source',
    };
    body = notif.body || notif.title;
  } else {
    headers = { 'content-type': 'application/json' };
    body = JSON.stringify({
      // campi generici
      key: notif.key, severity: notif.severity, ts: notif.ts,
      // Gotify / ntfy (self-hosted via JSON)
      title: notif.title, message: notif.body || notif.title, priority: { info: 3, warning: 6, error: 9 }[notif.severity] ?? 3,
      // Discord
      content: `**${notif.title}**${notif.body ? '\n' + notif.body : ''}`,
    });
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} da ${new URL(url).hostname}${isNtfy ? ' (formato ntfy)' : ''}`);
  } finally {
    clearTimeout(t);
  }
}

export function notifList({ limit = 50, offset = 0 } = {}) {
  const rows = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ? OFFSET ?').all(Math.min(limit, 200), offset);
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read = 0').get().n;
  return { rows, unread };
}
export function notifMarkRead(ids = null) {
  if (ids && ids.length) {
    const stmt = db.prepare('UPDATE notifications SET read = 1 WHERE id = ?');
    for (const id of ids) stmt.run(id);
  } else {
    db.prepare('UPDATE notifications SET read = 1').run();
  }
}
export function pruneNotifications() {
  db.prepare('DELETE FROM notifications WHERE ts < ?').run(Date.now() - 90 * 86400000);
}

// Soglie temperatura dischi: max (default 45 °C) e min opzionale (null = off).
export function tempThreshold() {
  return getSetting('tempThreshold', 45);
}
export function tempMinThreshold() {
  return getSetting('tempMin', null);
}
