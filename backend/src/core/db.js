// Database SQLite (better-sqlite3) in /config — WAL + busy_timeout,
// checkpoint periodico e su shutdown, backup giornaliero VACUUM INTO,
// guard FUSE/shfs (WAL su FUSE rischia corruzione).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './util.js';

export let db = null;
export let fuseWarning = false;

// Rileva il filesystem su cui vive una directory (longest prefix match su /proc/mounts).
function detectFsType(dir) {
  try {
    const real = fs.realpathSync(dir);
    const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
    let best = null;
    for (const line of mounts) {
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      const mnt = parts[1].replace(/\\040/g, ' ');
      if (real === mnt || real.startsWith(mnt.endsWith('/') ? mnt : mnt + '/')) {
        if (!best || mnt.length > best.mnt.length) best = { mnt, type: parts[2] };
      }
    }
    return best ? best.type : null;
  } catch {
    return null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret_enc TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  recovery_codes TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user TEXT,
  action TEXT NOT NULL,
  target TEXT,
  outcome TEXT NOT NULL,
  ip TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notif_ts ON notifications(ts);
CREATE TABLE IF NOT EXISTS notif_state (
  key TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0,
  last_sent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS update_cache (
  image_ref TEXT PRIMARY KEY,
  local_digest TEXT,
  remote_digest TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS registry_creds (
  registry TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS update_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_id TEXT NOT NULL,
  name TEXT NOT NULL,
  old_id TEXT,
  new_id TEXT,
  phase TEXT NOT NULL,
  payload TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS ups_energy (
  hour INTEGER PRIMARY KEY,
  wh REAL NOT NULL DEFAULT 0,
  samples INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS icon_cache (
  url_hash TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  file TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL
);
`;

export function initDb() {
  fs.mkdirSync(config.configDir, { recursive: true });
  fs.mkdirSync(path.join(config.configDir, 'backups'), { recursive: true });
  fs.mkdirSync(path.join(config.configDir, 'icons'), { recursive: true });

  const fsType = detectFsType(config.configDir);
  if (fsType && fsType.startsWith('fuse')) {
    fuseWarning = true;
    log.warn(`[db] ATTENZIONE: /config è su filesystem ${fsType} (FUSE/shfs). ` +
      `SQLite in WAL su FUSE rischia corruzione: usare un path diretto (es. /mnt/cache/appdata/unraiddeck) o una share "exclusive".`);
  }

  db = new Database(path.join(config.configDir, 'unraiddeck.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);

  // Checkpoint periodico (oltre a quello su shutdown)
  const t = setInterval(() => {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { log.warn('[db] checkpoint fallito:', e.message); }
  }, 5 * 60000);
  t.unref();

  return db;
}

// Backup giornaliero: VACUUM INTO /config/backups, retention 7 file.
export function runBackup() {
  const dir = path.join(config.configDir, 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(dir, `unraiddeck-${stamp}.db`);
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    const files = fs.readdirSync(dir).filter(f => f.startsWith('unraiddeck-') && f.endsWith('.db')).sort();
    while (files.length > 7) {
      fs.unlinkSync(path.join(dir, files.shift()));
    }
    log.info(`[db] backup creato: ${dest}`);
  } catch (e) {
    log.error('[db] backup fallito:', e.message);
  }
}

export function scheduleBackups() {
  // Primo backup dopo 5 minuti dall'avvio, poi ogni 24h.
  setTimeout(() => { runBackup(); setInterval(runBackup, 24 * 3600000).unref(); }, 5 * 60000).unref();
}

// Chiusura pulita: checkpoint WAL + close.
export function closeDb() {
  if (!db) return;
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignora */ }
  try { db.close(); } catch { /* ignora */ }
  db = null;
}

// Helper impostazioni chiave/valore.
export function getSetting(key, def = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : def;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
