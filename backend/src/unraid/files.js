// File manager delle share Unraid via SFTP (nessun mount richiesto: usa il
// fallback SSH). Percorsi confinati sotto /mnt; azioni distruttive in audit.
// I file si aprono nel browser con MIME corretto; HTML/SVG/JS serviti come
// text/plain per non eseguire script sull'origin dell'app.
import path from 'node:path';
import { sshConfigured, sshSftp } from './ssh-fallback.js';

const MIME = {
  txt: 'text/plain', md: 'text/plain', log: 'text/plain', conf: 'text/plain', cfg: 'text/plain',
  ini: 'text/plain', yml: 'text/plain', yaml: 'text/plain', sh: 'text/plain', py: 'text/plain',
  js: 'text/plain', ts: 'text/plain', css: 'text/plain', html: 'text/plain', htm: 'text/plain',
  xml: 'text/plain', svg: 'text/plain', csv: 'text/plain', json: 'application/json',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/opus',
  pdf: 'application/pdf',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
};

export function mimeFor(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

export function requireSsh() {
  if (!sshConfigured()) {
    const err = new Error('File manager: servono le credenziali SSH (SSH_USER + SSH_PASSWORD o SSH_KEY)');
    err.status = 400;
    throw err;
  }
}

// Confina i percorsi sotto /mnt (share, cache, dischi). Normalizza e rifiuta
// traversal: dopo normalize non devono restare "..".
export function safePath(p) {
  const n = path.posix.normalize(String(p || '/mnt/user'));
  if (n !== '/mnt' && !n.startsWith('/mnt/')) {
    const err = new Error('Percorso fuori da /mnt');
    err.status = 400;
    throw err;
  }
  if (n.split('/').includes('..')) {
    const err = new Error('Percorso non valido');
    err.status = 400;
    throw err;
  }
  return n;
}

export async function listDir(p) {
  requireSsh();
  const sftp = await sshSftp();
  const entries = await new Promise((resolve, reject) => {
    sftp.readdir(p, (err, list) => err ? reject(err) : resolve(list));
  });
  return entries.map((e) => ({
    name: e.filename,
    type: e.longname.startsWith('d') ? 'dir' : e.longname.startsWith('l') ? 'link' : 'file',
    size: e.attrs?.size ?? 0,
    mtime: (e.attrs?.mtime ?? 0) * 1000,
  })).sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
}

export async function statPath(p) {
  const sftp = await sshSftp();
  return new Promise((resolve, reject) => {
    sftp.stat(p, (err, st) => err ? reject(err) : resolve(st));
  });
}

// Streaming download verso la response (MIME per estensione, inline).
export async function streamDownload(p, res, asAttachment = false) {
  requireSsh();
  const sftp = await sshSftp();
  const st = await statPath(p);
  if (st.isDirectory()) {
    const err = new Error('È una directory');
    err.status = 400;
    throw err;
  }
  const name = path.posix.basename(p);
  res.setHeader('content-type', mimeFor(name));
  res.setHeader('content-length', st.size);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-disposition', `${asAttachment ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  await new Promise((resolve, reject) => {
    const rs = sftp.createReadStream(p);
    rs.on('error', reject);
    res.on('close', resolve);
    rs.pipe(res);
  });
}

// Upload: pipa la request (stream raw) su SFTP.
export async function streamUpload(p, req) {
  requireSsh();
  const sftp = await sshSftp();
  await new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(p);
    ws.on('error', reject);
    ws.on('close', resolve);
    req.on('error', reject);
    req.pipe(ws);
  });
}

export async function mkdir(p) {
  requireSsh();
  const sftp = await sshSftp();
  await new Promise((resolve, reject) => sftp.mkdir(p, (e) => e ? reject(e) : resolve()));
}

export async function rename(from, to) {
  requireSsh();
  const sftp = await sshSftp();
  await new Promise((resolve, reject) => sftp.rename(from, to, (e) => e ? reject(e) : resolve()));
}

// Elimina file o directory VUOTA (niente ricorsione: troppo pericoloso via UI).
export async function remove(p) {
  requireSsh();
  const sftp = await sshSftp();
  const st = await statPath(p);
  await new Promise((resolve, reject) => {
    const cb = (e) => e ? reject(e) : resolve();
    if (st.isDirectory()) sftp.rmdir(p, cb);
    else sftp.unlink(p, cb);
  });
}
