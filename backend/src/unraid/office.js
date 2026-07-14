// Integrazione opzionale OnlyOffice Document Server (container separato, es.
// da Community Applications): apre e MODIFICA docx/xlsx/pptx & co. come una
// suite Office vera. UnraidDeck espone il file al DS con un token usa-e-getta
// e riceve il salvataggio via callback → scrittura su share via SFTP.
// Env: ONLYOFFICE_URL (es. http://IP:8082), ONLYOFFICE_JWT_SECRET (se il DS
// ha JWT attivo — default nelle versioni recenti).
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from '../core/config.js';
import { statPath, streamUploadFromStream } from './files.js';
import { audit } from '../core/audit.js';
import { log } from '../core/util.js';

const SESSION_TTL = 12 * 3600000; // il callback di chiusura può arrivare ore dopo
const sessions = new Map();       // token -> { path, name, user, exp }

// Estensioni per tipo editor DS; l'edit vero è sui formati OOXML
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

function prune() {
  const now = Date.now();
  for (const [tok, s] of sessions) if (s.exp < now) sessions.delete(tok);
}

// JWT HS256 minimale (il DS recente rifiuta le richieste non firmate)
function jwtSign(payload, secret) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

// Crea la sessione editor: ritorna la config per DocsAPI.DocEditor.
export async function createSession(filePath, baseUrl, user) {
  if (!officeConfigured()) {
    const err = new Error('OnlyOffice non configurato: imposta ONLYOFFICE_URL');
    err.status = 400;
    throw err;
  }
  const name = path.posix.basename(filePath);
  const ext = name.split('.').pop().toLowerCase();
  const type = docType(ext);
  if (!type) {
    const err = new Error(`Formato .${ext} non supportato da OnlyOffice`);
    err.status = 400;
    throw err;
  }
  prune();
  const st = await statPath(filePath);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { path: filePath, name, user, exp: Date.now() + SESSION_TTL });

  const cfg = {
    type: 'desktop',
    documentType: type,
    document: {
      fileType: ext,
      // key = versione documento: cambia a ogni modifica (mtime/size)
      key: crypto.createHash('sha1').update(`${filePath}|${st.mtime}|${st.size}`).digest('hex').slice(0, 20),
      title: name,
      url: `${baseUrl}/api/unraid/office/doc/${token}`,
      permissions: { edit: EDITABLE.includes(ext), download: true, print: true },
    },
    editorConfig: {
      mode: EDITABLE.includes(ext) ? 'edit' : 'view',
      lang: 'it',
      callbackUrl: `${baseUrl}/api/unraid/office/callback/${token}`,
      user: { id: user, name: user },
      customization: { autosave: true, compactHeader: true, forcesave: true },
    },
  };
  if (config.onlyofficeJwtSecret) cfg.token = jwtSign(cfg, config.onlyofficeJwtSecret);
  return { config: cfg, apiJs: `${config.onlyofficeUrl}/web-apps/apps/api/documents/api.js` };
}

export function sessionFor(token) {
  prune();
  return sessions.get(token) || null;
}

// Callback DS: status 2/6 = documento pronto per il salvataggio → scarica dal
// DS e riscrivi sulla share. Risposta SEMPRE {error:0} altrimenti il DS ritenta.
export async function handleCallback(token, body) {
  const sess = sessionFor(token);
  if (!sess) return { error: 1, message: 'sessione scaduta' };
  const status = Number(body?.status);
  if ((status === 2 || status === 6) && body?.url) {
    const res = await fetch(body.url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`download dal Document Server fallito: HTTP ${res.status}`);
    await streamUploadFromStream(sess.path, Readable.fromWeb(res.body));
    audit(sess.user, 'files.office-save', sess.path, 'ok', null, `status ${status}`);
    log.info(`[office] salvato ${sess.name} (status ${status})`);
  }
  return { error: 0 };
}
