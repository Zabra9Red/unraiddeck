// Integrazione OnlyOffice Document Server (container esterno, opzionale —
// l'editing embedded è Collabora nell'immagine :office).
// "Per bene": sessioni persistite in SQLite (sopravvivono ai riavvii, i
// callback del DS arrivano anche ore dopo), storage con dispatch locale/SFTP
// (locale = salvataggio atomico + versioning), verifica del JWT anche in
// INGRESSO (doc + callback), healthcheck con messaggi chiari, gestione degli
// stati di errore del DS. Env: ONLYOFFICE_URL, ONLYOFFICE_JWT_SECRET,
// ONLYOFFICE_SELF_URL (base URL con cui il DS raggiunge UnraidDeck, se
// l'hostname usato dal browser non è risolvibile dal DS).
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from '../core/config.js';
import { db } from '../core/db.js';
import { statPath, streamUploadFromStream, streamDownload, safePath } from './files.js';
import * as lfs from '../files/local-fs.js';
import { audit } from '../core/audit.js';
import { notify } from '../core/notify.js';
import { log } from '../core/util.js';

const SESSION_TTL = 24 * 3600000;

const TYPES = {
  word: ['doc', 'docx', 'odt', 'rtf', 'txt', 'docm', 'dot', 'dotx', 'epub', 'fb2'],
  cell: ['xls', 'xlsx', 'ods', 'csv', 'xlsm', 'xlt', 'xltx'],
  slide: ['ppt', 'pptx', 'odp', 'pps', 'ppsx', 'pptm'],
};
const EDITABLE = ['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm', 'csv', 'txt'];

export function officeConfigured() {
  return Boolean(config.onlyofficeUrl);
}
export function officeSupports(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return Object.values(TYPES).some(l => l.includes(ext));
}
function docType(ext) {
  for (const [type, list] of Object.entries(TYPES)) if (list.includes(ext)) return type;
  return null;
}

// ---- Storage: locale (atomico+versioni) quando montato, altrimenti SFTP ----
const useLocal = () => lfs.fmAvailable();
async function resolveAny(p) {
  return useLocal() ? lfs.resolveSafe(p) : safePath(p);
}
async function statAny(p) {
  if (useLocal()) {
    const st = await (await import('node:fs/promises')).stat(p);
    return { size: st.size, mtime: st.mtimeMs };
  }
  const st = await statPath(p);
  return { size: st.size, mtime: (st.mtime || 0) * 1000 };
}
async function writeAny(p, readable, user) {
  if (useLocal()) return lfs.saveAtomic(p, readable, { user });
  return streamUploadFromStream(p, readable);
}
export async function streamDocTo(p, req, res) {
  if (useLocal()) {
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(p))}`);
    return lfs.streamRaw(p, req, res);
  }
  return streamDownload(p, res, true);
}

// ---- JWT HS256 (firma in uscita + VERIFICA in ingresso) ----
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwtSign(payload, secret) {
  const head = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
export function jwtVerify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const sig = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(sig))) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return null; }
}
// Il DS manda il JWT nell'header Authorization (Bearer) e/o nel body.token.
export function verifyInbound(req) {
  if (!config.onlyofficeJwtSecret) return true;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const tok = req.body?.token || bearer;
  if (!tok) return false;
  return Boolean(jwtVerify(tok, config.onlyofficeJwtSecret));
}

// ---- Sessioni persistite (il callback di chiusura può arrivare molto dopo) ----
function pruneSessions() {
  db.prepare('DELETE FROM office_sessions WHERE exp < ?').run(Date.now());
}
export function sessionFor(token) {
  pruneSessions();
  return db.prepare('SELECT * FROM office_sessions WHERE token = ?').get(token) || null;
}

// ---- Healthcheck DS (cache 60 s) ----
let lastHealth = { ok: false, t: 0 };
async function dsHealthy() {
  if (Date.now() - lastHealth.t < 60000) return lastHealth.ok;
  try {
    const res = await fetch(`${config.onlyofficeUrl}/healthcheck`, { signal: AbortSignal.timeout(5000) });
    lastHealth = { ok: res.ok && (await res.text()).trim() === 'true', t: Date.now() };
  } catch {
    lastHealth = { ok: false, t: Date.now() };
  }
  return lastHealth.ok;
}

export async function createSession(filePath, baseUrl, user) {
  if (!officeConfigured()) {
    const err = new Error('OnlyOffice non configurato: imposta ONLYOFFICE_URL');
    err.status = 400;
    throw err;
  }
  if (!await dsHealthy()) {
    const err = new Error(`Document Server non raggiungibile su ${config.onlyofficeUrl} (healthcheck fallito): controlla che il container OnlyOffice sia attivo`);
    err.status = 502;
    throw err;
  }
  const p = await resolveAny(filePath);
  const name = path.posix.basename(p);
  const ext = name.split('.').pop().toLowerCase();
  const type = docType(ext);
  if (!type) {
    const err = new Error(`Formato .${ext} non supportato da OnlyOffice`);
    err.status = 400;
    throw err;
  }
  pruneSessions();
  const st = await statAny(p);
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO office_sessions (token, path, name, user, exp) VALUES (?, ?, ?, ?, ?)')
    .run(token, p, name, user, Date.now() + SESSION_TTL);

  const base = (config.onlyofficeSelfUrl || baseUrl).replace(/\/+$/, '');
  const cfg = {
    type: 'desktop',
    documentType: type,
    document: {
      fileType: ext,
      key: crypto.createHash('sha1').update(`${p}|${Math.round(st.mtime)}|${st.size}`).digest('hex').slice(0, 20),
      title: name,
      url: `${base}/api/unraid/office/doc/${token}`,
      permissions: { edit: EDITABLE.includes(ext), download: true, print: true },
    },
    editorConfig: {
      mode: EDITABLE.includes(ext) ? 'edit' : 'view',
      lang: 'it',
      callbackUrl: `${base}/api/unraid/office/callback/${token}`,
      user: { id: user, name: user },
      customization: { autosave: true, compactHeader: true, forcesave: true },
    },
  };
  if (config.onlyofficeJwtSecret) cfg.token = jwtSign(cfg, config.onlyofficeJwtSecret);
  audit(user, 'files.office-open', p, 'ok', null, 'onlyoffice');
  return { config: cfg, apiJs: `${config.onlyofficeUrl}/web-apps/apps/api/documents/api.js` };
}

// Callback DS. Stati: 1 editing, 2 pronto per salvataggio, 3 errore
// salvataggio, 4 chiuso senza modifiche, 6 force-save, 7 errore force-save.
// Risposta SEMPRE {error:0} sui percorsi gestiti, altrimenti il DS ritenta.
export async function handleCallback(token, body, req) {
  if (!verifyInbound(req)) return { error: 1, message: 'JWT non valido' };
  const sess = sessionFor(token);
  if (!sess) return { error: 1, message: 'sessione scaduta' };
  const status = Number(body?.status);
  if ((status === 2 || status === 6) && body?.url) {
    const res = await fetch(body.url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`download dal Document Server fallito: HTTP ${res.status}`);
    await writeAny(sess.path, Readable.fromWeb(res.body), sess.user);
    audit(sess.user, 'files.office-save', sess.path, 'ok', null, `onlyoffice status ${status}`);
    log.info(`[office] salvato ${sess.name} (status ${status})`);
  } else if (status === 3 || status === 7) {
    log.warn(`[office] DS segnala errore di salvataggio su ${sess.name} (status ${status})`);
    notify(`office-err:${sess.name}`, 'error', `Salvataggio fallito: ${sess.name}`,
      'Il Document Server OnlyOffice non è riuscito a salvare il documento.', { force: true });
    audit(sess.user, 'files.office-save', sess.path, 'errore', null, `onlyoffice status ${status}`);
  }
  return { error: 0 };
}

