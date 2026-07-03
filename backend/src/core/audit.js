// Audit log in SQLite: utente, azione, target, esito, IP. Retention 90 gg / 20k righe.
import { db } from './db.js';

export function audit(user, action, target, outcome, ip = null, details = null) {
  try {
    db.prepare('INSERT INTO audit (ts, user, action, target, outcome, ip, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), user || null, action, target || null, outcome, ip, details ? String(details).slice(0, 500) : null);
  } catch { /* l'audit non deve mai bloccare l'operazione */ }
}

export function auditList({ limit = 100, offset = 0, action = null, user = null } = {}) {
  let sql = 'SELECT * FROM audit';
  const where = [];
  const params = [];
  if (action) { where.push('action LIKE ?'); params.push(`${action}%`); }
  if (user) { where.push('user = ?'); params.push(user); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(Math.min(limit, 500), offset);
  const rows = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) AS n FROM audit').get().n;
  return { rows, total };
}

// Retention: 90 giorni oppure massimo 20k righe.
export function pruneAudit() {
  db.prepare('DELETE FROM audit WHERE ts < ?').run(Date.now() - 90 * 86400000);
  db.prepare(`DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 20000)`).run();
}
