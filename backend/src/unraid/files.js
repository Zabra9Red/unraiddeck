// File manager delle share Unraid via SFTP (nessun mount richiesto: usa il
// fallback SSH). Percorsi confinati sotto /mnt; azioni distruttive in audit.
// I file si aprono nel browser con MIME corretto; HTML/SVG/JS serviti come
// text/plain per non eseguire script sull'origin dell'app.
import path from 'node:path';
import zlib from 'node:zlib';
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
  // La CSP dell'app (object-src 'none') impedirebbe a Chrome di renderizzare i
  // PDF inline: questa risposta è un file, non una pagina — via la CSP.
  // Sicuro: HTML/SVG/JS escono come text/plain, niente script sull'origin.
  res.removeHeader('content-security-policy');
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
  return streamUploadFromStream(p, req);
}

// Scrive un readable qualsiasi su SFTP (upload UI, salvataggi OnlyOffice).
export async function streamUploadFromStream(p, readable) {
  requireSsh();
  const sftp = await sshSftp();
  await new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(p);
    ws.on('error', reject);
    ws.on('close', resolve);
    readable.on('error', reject);
    readable.pipe(ws);
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

// Legge i primi N byte (per la detection testo/binario dei file senza estensione).
async function readHead(p, bytes = 4096) {
  const sftp = await sshSftp();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let got = 0;
    const rs = sftp.createReadStream(p, { start: 0, end: bytes - 1 });
    rs.on('data', (c) => { chunks.push(c); got += c.length; if (got >= bytes) rs.destroy(); });
    rs.on('error', reject);
    rs.on('close', () => resolve(Buffer.concat(chunks)));
    rs.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Euristica testo/binario: nessun NUL e >90% di byte stampabili/whitespace.
export function isProbablyText(buf) {
  if (!buf.length) return true;
  let printable = 0;
  for (const b of buf) {
    if (b === 0) return false;
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127)) printable += 1;
  }
  return printable / buf.length > 0.9;
}

// { isText, size } per decidere lato client se aprire l'editor.
export async function peek(p) {
  requireSsh();
  const st = await statPath(p);
  if (st.isDirectory()) {
    const err = new Error('È una directory');
    err.status = 400;
    throw err;
  }
  const head = await readHead(p);
  return { isText: isProbablyText(head), size: st.size };
}

// Legge un file intero in memoria (cap dimensione, per l'estrazione documenti).
async function readAll(p, maxBytes = 20 * 1024 * 1024) {
  const st = await statPath(p);
  if (st.size > maxBytes) {
    const err = new Error(`File troppo grande (${Math.round(st.size / 1048576)} MB, max ${Math.round(maxBytes / 1048576)})`);
    err.status = 400;
    throw err;
  }
  const sftp = await sshSftp();
  return new Promise((resolve, reject) => {
    const chunks = [];
    const rs = sftp.createReadStream(p);
    rs.on('data', (c) => chunks.push(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ---- Mini lettore ZIP (per docx/odt): central directory → entry → inflateRaw ----
export function unzipEntry(buf, wantedName) {
  // EOCD (0x06054b50) cercato dalla coda; poi central directory (0x02014b50)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP non valido');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === wantedName) {
      // Local header: name/extra possono differire dal central directory
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      return method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`Voce "${wantedName}" non trovata nel documento`);
}

function xmlToText(xml) {
  return xml
    .replace(/<\/w:p>|<\/text:p>/g, '\n')
    .replace(/<w:tab\/>|<text:tab\/>/g, '\t')
    .replace(/<w:br\/>|<text:line-break\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Sequenze stampabili (stile `strings`) per i .doc binari legacy.
function extractStrings(buf) {
  const out = [];
  let cur = [];
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xC0) cur.push(b);
    else { if (cur.length >= 6) out.push(Buffer.from(cur).toString('utf8')); cur = []; }
  }
  if (cur.length >= 6) out.push(Buffer.from(cur).toString('utf8'));
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// Estrae il testo leggibile da docx/odt/rtf/doc → { text, lossy }.
export async function extractText(p) {
  requireSsh();
  const ext = String(p).split('.').pop().toLowerCase();
  const buf = await readAll(p);
  if (ext === 'docx') return { text: xmlToText(unzipEntry(buf, 'word/document.xml').toString('utf8')), lossy: false };
  if (ext === 'odt') return { text: xmlToText(unzipEntry(buf, 'content.xml').toString('utf8')), lossy: false };
  if (ext === 'rtf') {
    const text = buf.toString('utf8')
      .replace(/\\par[d]?/g, '\n')
      .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\[a-z]+-?\d*\s?/gi, '')
      .replace(/[{}]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text, lossy: false };
  }
  // .doc legacy e qualunque altro binario: estrazione "strings" (con perdita)
  return { text: extractStrings(buf), lossy: true };
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
