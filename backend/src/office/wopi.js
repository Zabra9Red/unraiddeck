// WOPI host per Collabora (spec §6.4): token firmati short-scope (path+utente+
// permesso), lock persistiti in SQLite (TTL 30 min, semantica X-WOPI-Lock),
// PutFile → salvataggio atomico + versioning + audit. Le route accettano solo
// loopback: coolwsd è l'unico client legittimo.
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { db } from '../core/db.js';
import { resolveSafe, saveAtomic, streamRaw } from '../files/local-fs.js';
import { audit } from '../core/audit.js';
import { log } from '../core/util.js';

const SECRET = crypto.randomBytes(32); // per-process: le sessioni muoiono col container
const TOKEN_TTL = 12 * 3600000;
const LOCK_TTL = 30 * 60000;

const b64u = (s) => Buffer.from(s).toString('base64url');

export function makeToken(filePath, user, canWrite) {
  const payload = b64u(JSON.stringify({ p: filePath, u: user, w: canWrite, e: Date.now() + TOKEN_TTL }));
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const good = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (data.e < Date.now()) return null;
  return { path: data.p, user: data.u, canWrite: data.w };
}

// ---- Lock (tabella wopi_locks) ----
function pruneLocks() {
  db.prepare('DELETE FROM wopi_locks WHERE exp < ?').run(Date.now());
}
export function currentLock(filePath) {
  pruneLocks();
  return db.prepare('SELECT lock_id FROM wopi_locks WHERE path = ?').get(filePath)?.lock_id || null;
}

export function handleLockOp(filePath, override, lockId, oldLockId) {
  pruneLocks();
  const cur = currentLock(filePath);
  const set = (id) => db.prepare(
    'INSERT INTO wopi_locks (path, lock_id, exp) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET lock_id = excluded.lock_id, exp = excluded.exp')
    .run(filePath, id, Date.now() + LOCK_TTL);
  const clear = () => db.prepare('DELETE FROM wopi_locks WHERE path = ?').run(filePath);

  switch (override) {
    case 'LOCK':
      if (oldLockId) { // UnlockAndRelock
        if (cur && cur !== oldLockId) return { status: 409, lock: cur };
        set(lockId);
        return { status: 200 };
      }
      if (cur && cur !== lockId) return { status: 409, lock: cur };
      set(lockId);
      return { status: 200 };
    case 'GET_LOCK':
      return { status: 200, lock: cur || '' };
    case 'REFRESH_LOCK':
      if (cur !== lockId) return { status: 409, lock: cur || '' };
      set(lockId);
      return { status: 200 };
    case 'UNLOCK':
      if (cur !== lockId) return { status: 409, lock: cur || '' };
      clear();
      return { status: 200 };
    default:
      return { status: 501 };
  }
}

// ---- Handler route ----
export async function checkFileInfo(tok, res) {
  const p = await resolveSafe(tok.path);
  const st = fs.statSync(p);
  res.json({
    BaseFileName: path.basename(p),
    Size: st.size,
    Version: String(Math.round(st.mtimeMs)),
    OwnerId: 'unraiddeck',
    UserId: tok.user,
    UserFriendlyName: tok.user,
    UserCanWrite: Boolean(tok.canWrite),
    SupportsLocks: true,
    SupportsUpdate: true,
    SupportsGetLock: true,
  });
}

export async function getFile(tok, req, res) {
  const p = await resolveSafe(tok.path);
  await streamRaw(p, req, res);
}

export async function putFile(tok, req, res) {
  if (!tok.canWrite) return res.status(403).json({ error: 'sola lettura' });
  const p = await resolveSafe(tok.path);
  const reqLock = req.headers['x-wopi-lock'];
  const cur = currentLock(p);
  if (cur && reqLock !== cur) {
    res.setHeader('x-wopi-lock', cur);
    return res.status(409).end();
  }
  const out = await saveAtomic(p, req, { user: tok.user });
  audit(tok.user, 'files.office-save', p, 'ok', null, 'collabora');
  log.info(`[wopi] PutFile ${p} (${out.size} B)`);
  res.setHeader('x-wopi-itemversion', String(Math.round(out.mtime)));
  res.json({});
}
