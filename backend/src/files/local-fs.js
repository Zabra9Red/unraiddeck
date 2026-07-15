// File manager locale (spec Viewer&Editor v1.2): opera sul bind mount
// /mnt→/unraid (FM_ROOTS). Detection sul contenuto (magic bytes → `file` →
// euristica testo), streaming con Range, salvataggio ATOMICO FUSE-safe
// (tmp nella stessa dir + fsync + rename, mode/uid/gid preservati),
// backup .orig una-tantum e versioning in /config/cache/versions.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { config } from '../core/config.js';
import { log } from '../core/util.js';

const err400 = (m) => { const e = new Error(m); e.status = 400; return e; };

export function fmRoots() {
  return (config.fmRoots || '/unraid').split(':').filter(Boolean);
}
export function fmAvailable() {
  return fmRoots().some((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
}

const inRoots = (p) => fmRoots().some((r) => p === r || p.startsWith(r + '/'));

// Anti path-traversal: resolve + prefisso root; symlink risolti e ri-validati.
// Alias: i percorsi /mnt/... (come li pensa l'utente Unraid) vengono mappati
// sul mount interno (/unraid/...) quando /mnt non è tra i root.
export async function resolveSafe(p, { mustExist = true } = {}) {
  let n = path.resolve(String(p || fmRoots()[0]));
  if (!inRoots(n) && (n === '/mnt' || n.startsWith('/mnt/'))) {
    const mapped = path.posix.join(fmRoots()[0], n.slice('/mnt'.length) || '/');
    if (inRoots(mapped)) n = mapped;
  }
  if (!inRoots(n)) throw err400('Percorso fuori dai root consentiti');
  try {
    const real = await fsp.realpath(n);
    if (!inRoots(real)) throw err400('Symlink fuori dai root consentiti');
    return real;
  } catch (e) {
    if (e.status) throw e;
    if (mustExist) throw Object.assign(new Error('File non trovato'), { status: 404 });
    // Target nuovo (save-as): valida la directory reale
    const parent = await fsp.realpath(path.dirname(n));
    if (!inRoots(parent)) throw err400('Directory fuori dai root consentiti');
    return path.join(parent, path.basename(n));
  }
}

export async function listDir(p) {
  const entries = await fsp.readdir(p, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    try {
      const st = await fsp.lstat(path.join(p, e.name));
      out.push({
        name: e.name,
        type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'file',
        size: st.size,
        mtime: st.mtimeMs,
      });
    } catch { /* file sparito durante il listing */ }
  }
  return out.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
}

// ---- Detection (spec §4) ----
const SENSITIVE_RX = /(^id_(rsa|ed25519|ecdsa|dsa)\b|\.key$|^shadow$|^\.env|wpa_supplicant|\.kdbx$)/i;

async function readHead(p, bytes = 4100) {
  const fd = await fsp.open(p, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fd.close(); }
}

function textHeuristic(buf) {
  if (!buf.length) return { isText: true, encoding: 'utf-8' };
  if (buf.includes(0)) return { isText: false, encoding: null };
  // BOM
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { isText: true, encoding: 'utf-8', bom: true };
  if (buf[0] === 0xFF && buf[1] === 0xFE) return { isText: true, encoding: 'utf-16le', bom: true };
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { isText: true, encoding: 'utf-8' };
  } catch {
    let printable = 0;
    for (const b of buf) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127)) printable += 1;
    if (printable / buf.length > 0.95) return { isText: true, encoding: 'latin1' };
    return { isText: false, encoding: null };
  }
}

function fileCliMime(p) {
  return new Promise((resolve) => {
    execFile('file', ['--mime-type', '--brief', p], { timeout: 10000 }, (e, stdout) => {
      resolve(e ? null : stdout.trim());
    });
  });
}

const CATEGORY = [
  [/^image\//, 'image'], [/^video\//, 'video'], [/^audio\//, 'audio'],
  [/pdf$/, 'pdf'], [/^text\//, 'text'],
  [/(zip|x-tar|gzip|x-bzip2|x-xz|x-7z|x-rar|zstd|x-iso9660)/, 'archive'],
  [/(msword|wordprocessingml|spreadsheetml|presentationml|opendocument|rtf)/, 'office'],
  [/(sqlite)/, 'sqlite'], [/json/, 'text'], [/xml/, 'text'],
];

export async function inspect(p) {
  const st = await fsp.lstat(p);
  const base = {
    path: p, name: path.basename(p), size: st.size, mtime: st.mtimeMs, mode: st.mode & 0o777,
    sensitive: SENSITIVE_RX.test(path.basename(p)),
  };
  if (st.isDirectory()) return { ...base, category: 'dir', mime: 'inode/directory', isText: false, canWrite: false };
  if (!st.isFile()) return { ...base, category: 'special', mime: 'inode/special', isText: false, canWrite: false };

  const head = await readHead(p);
  let mime = null;
  try {
    const { fileTypeFromBuffer } = await import('file-type');
    mime = (await fileTypeFromBuffer(head))?.mime || null;
  } catch { /* file-type non disponibile */ }
  if (!mime) mime = await fileCliMime(p);
  const txt = textHeuristic(head);
  if (!mime || mime === 'application/octet-stream' || mime === 'inode/x-empty') {
    mime = txt.isText ? 'text/plain' : 'application/octet-stream';
  }
  let category = (CATEGORY.find(([rx]) => rx.test(mime)) || [null, null])[1];
  if (!category) category = txt.isText ? 'text' : 'binary';
  // EOL dal campione (per preservarlo al save)
  const sample = head.toString(txt.encoding === 'latin1' ? 'latin1' : 'utf8');
  const eol = sample.includes('\r\n') ? 'crlf' : 'lf';

  let canWrite = false;
  if (config.fmEditEnabled) {
    try { await fsp.access(p, fs.constants.W_OK); canWrite = true; } catch { /* read-only */ }
  }
  return { ...base, mime, category, isText: txt.isText, encoding: txt.encoding, bom: Boolean(txt.bom), eol, canWrite };
}

// ---- Streaming con Range + ETag (spec §8 /raw) ----
export async function streamRaw(p, req, res) {
  const st = await fsp.stat(p);
  const etag = `"${st.size}-${Math.round(st.mtimeMs)}"`;
  res.setHeader('etag', etag);
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('x-content-type-options', 'nosniff');
  res.removeHeader('content-security-policy');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  const head = await readHead(p, 512).catch(() => Buffer.alloc(0));
  let mime = null;
  try {
    const { fileTypeFromBuffer } = await import('file-type');
    mime = (await fileTypeFromBuffer(head))?.mime || null;
  } catch { /* ignora */ }
  if (!mime) mime = textHeuristic(head).isText ? 'text/plain; charset=utf-8' : 'application/octet-stream';
  // HTML dell'utente: mai eseguito nel contesto dell'app
  if (/html/.test(mime)) res.setHeader('content-security-policy', 'sandbox');
  res.setHeader('content-type', mime);

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = st.size - 1;
  if (range && (range[1] || range[2])) {
    start = range[1] ? parseInt(range[1], 10) : Math.max(0, st.size - parseInt(range[2], 10));
    end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : end;
    if (start > end || start >= st.size) {
      res.setHeader('content-range', `bytes */${st.size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('content-range', `bytes ${start}-${end}/${st.size}`);
  }
  res.setHeader('content-length', end - start + 1);
  if (req.method === 'HEAD') return res.end();
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(p, { start, end });
    rs.on('error', reject);
    res.on('close', () => { rs.destroy(); resolve(); });
    rs.pipe(res);
  });
}

// ---- Versioning (spec §6.5) ----
const versionsDir = () => path.join(config.configDir, 'cache', 'versions');
const versKey = (p) => crypto.createHash('sha1').update(p).digest('hex');

async function saveVersion(p) {
  if (!config.fmKeepVersions) return;
  const dir = path.join(versionsDir(), versKey(p));
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, String(Date.now()));
  await fsp.copyFile(p, dest);
  const all = (await fsp.readdir(dir)).sort();
  while (all.length > config.fmKeepVersions) await fsp.unlink(path.join(dir, all.shift()));
}

export async function listVersions(p) {
  const dir = path.join(versionsDir(), versKey(p));
  try {
    const names = (await fsp.readdir(dir)).sort().reverse();
    const out = [];
    for (const n of names) {
      const st = await fsp.stat(path.join(dir, n));
      out.push({ ts: parseInt(n, 10), size: st.size });
    }
    return out;
  } catch { return []; }
}

export function versionFile(p, ts) {
  return path.join(versionsDir(), versKey(p), String(ts));
}

// ---- Salvataggio atomico FUSE-safe (spec §1.4) ----
export async function saveAtomic(p, readable, { baseMtime = null, user = 'sistema' } = {}) {
  if (!config.fmEditEnabled) throw err400('Editing disabilitato (FM_EDIT_ENABLED=false)');
  let orig = null;
  try { orig = await fsp.stat(p); } catch { /* file nuovo */ }
  if (orig && baseMtime != null && Math.round(orig.mtimeMs) !== Math.round(Number(baseMtime))) {
    const e = new Error('Il file è cambiato su disco dopo l\'apertura: ricarica o salva come copia');
    e.status = 409;
    throw e;
  }
  if (orig) {
    // Backup .orig una-tantum + versione della copia precedente
    if (config.fmOrigBackup) {
      const bak = `${p}.orig`;
      try { await fsp.access(bak); } catch { await fsp.copyFile(p, bak).catch(() => {}); }
    }
    await saveVersion(p).catch((e) => log.warn('[fm] versione non salvata:', e.message));
  }
  // tmp NELLA STESSA DIR (rename cross-device su FUSE = EXDEV)
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.tmp-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const fh = await fsp.open(tmp, 'w', orig ? orig.mode & 0o777 : 0o644);
    await new Promise((resolve, reject) => {
      const ws = fh.createWriteStream();
      ws.on('error', reject);
      ws.on('finish', resolve);
      readable.on('error', reject);
      readable.pipe(ws);
    });
    await fh.sync().catch(() => {});
    await fh.close();
    if (orig) await fsp.chown(tmp, orig.uid, orig.gid).catch(() => {});
    await fsp.rename(tmp, p);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
  const st = await fsp.stat(p);
  log.info(`[fm] salvato ${p} (${st.size} B, ${user})`);
  return { size: st.size, mtime: st.mtimeMs };
}

// ---- Operazioni base ----
export const mkdirLocal = (p) => fsp.mkdir(p);
export const renameLocal = (from, to) => fsp.rename(from, to);
export async function removeLocal(p) {
  const st = await fsp.lstat(p);
  if (st.isDirectory()) await fsp.rmdir(p);
  else await fsp.unlink(p);
}
