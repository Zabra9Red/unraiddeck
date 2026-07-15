// Server WebDAV nativo su /dav (funzione "sync" di Nextcloud/Seafile/oCIS,
// senza container esterni): qualsiasi client WebDAV (Windows, macOS, GNOME,
// Documents/iOS, Solid Explorer/Android, rclone) monta le share.
// Auth: Basic con le credenziali dell'app (bcrypt); richiede il mount locale
// /unraid. Scritture atomiche, tutto in audit.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../core/db.js';
import { config } from '../core/config.js';
import { audit } from '../core/audit.js';
import { log } from '../core/util.js';
import { fmAvailable, fmRoots, resolveSafe, saveAtomic, streamRaw } from '../files/local-fs.js';

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Basic auth → utente app (rate-limit leggero in RAM per IP)
const fails = new Map();
function basicAuth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  const [user, ...pw] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  const password = pw.join(':');
  const ip = req.socket.remoteAddress;
  const f = fails.get(ip);
  if (f && f.n >= 10 && Date.now() - f.t < 600000) return null; // 10 tentativi / 10 min
  const row = db.prepare('SELECT username, password_hash FROM users WHERE username = ?').get(user);
  if (row && bcrypt.compareSync(password, row.password_hash)) {
    fails.delete(ip);
    return row.username;
  }
  fails.set(ip, { n: (f?.n || 0) + 1, t: Date.now() });
  return null;
}

// req.path è GIÀ senza il prefisso /dav (middleware montato su /dav);
// per l'header Destination invece il prefisso va tolto.
function davPathToFs(rel) {
  return path.posix.join(fmRoots()[0], decodeURIComponent(rel) || '/');
}
const stripDav = (p) => p.replace(/^\/dav(\/|$)/, '/');
const fsToDav = (p) => '/dav' + encodeURI(p.slice(fmRoots()[0].length) || '/');

async function propfindEntry(p, st) {
  const isDir = st.isDirectory();
  return `<D:response>
<D:href>${xmlEsc(fsToDav(p))}${isDir && !p.endsWith('/') ? '/' : ''}</D:href>
<D:propstat><D:prop>
<D:displayname>${xmlEsc(path.basename(p) || '/')}</D:displayname>
<D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>
${isDir ? '' : `<D:getcontentlength>${st.size}</D:getcontentlength>`}
<D:getlastmodified>${new Date(st.mtimeMs).toUTCString()}</D:getlastmodified>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>`;
}

export function webdavMiddleware() {
  return async (req, res) => {
    try {
      if (!fmAvailable()) return res.status(503).type('text/plain').send('WebDAV richiede il mount /mnt → /unraid');
      const user = config.disableAuth ? 'anonimo' : basicAuth(req);
      if (!user) {
        res.setHeader('www-authenticate', 'Basic realm="UnraidDeck"');
        return res.status(401).type('text/plain').send('Autenticazione richiesta');
      }
      const p = await resolveSafe(davPathToFs(req.path), { mustExist: !['PUT', 'MKCOL', 'MOVE', 'COPY', 'LOCK', 'OPTIONS'].includes(req.method) });

      switch (req.method) {
        case 'OPTIONS':
          res.setHeader('dav', '1, 2');
          res.setHeader('allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK');
          res.setHeader('ms-author-via', 'DAV');
          return res.status(200).end();

        case 'PROPFIND': {
          const depth = req.headers.depth === '0' ? 0 : 1;
          const st = await fsp.stat(p);
          const parts = [await propfindEntry(p, st)];
          if (depth === 1 && st.isDirectory()) {
            for (const name of await fsp.readdir(p)) {
              try {
                const cp = path.join(p, name);
                parts.push(await propfindEntry(cp, await fsp.stat(cp)));
              } catch { /* entry sparita/illeggibile */ }
            }
          }
          res.status(207).type('application/xml');
          return res.send(`<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${parts.join('\n')}</D:multistatus>`);
        }

        case 'GET':
        case 'HEAD': {
          const st = await fsp.stat(p);
          if (st.isDirectory()) return res.status(405).end();
          return streamRaw(p, req, res);
        }

        case 'PUT':
          await saveAtomic(p, req, { user });
          audit(user, 'webdav.put', p, 'ok', req.ip);
          return res.status(201).end();

        case 'MKCOL':
          await fsp.mkdir(p);
          audit(user, 'webdav.mkcol', p, 'ok', req.ip);
          return res.status(201).end();

        case 'DELETE': {
          const st = await fsp.lstat(p);
          if (st.isDirectory()) await fsp.rm(p, { recursive: true });
          else await fsp.unlink(p);
          audit(user, 'webdav.delete', p, 'ok', req.ip);
          return res.status(204).end();
        }

        case 'MOVE':
        case 'COPY': {
          const destHdr = req.headers.destination || '';
          const destPath = new URL(destHdr, 'http://x').pathname;
          if (!destPath.startsWith('/dav/')) return res.status(400).end();
          const dest = await resolveSafe(davPathToFs(stripDav(destPath)), { mustExist: false });
          const overwrite = req.headers.overwrite !== 'F';
          const exists = fs.existsSync(dest);
          if (exists && !overwrite) return res.status(412).end();
          if (req.method === 'MOVE') await fsp.rename(p, dest);
          else await fsp.cp(p, dest, { recursive: true });
          audit(user, `webdav.${req.method.toLowerCase()}`, `${p} → ${dest}`, 'ok', req.ip);
          return res.status(exists ? 204 : 201).end();
        }

        case 'PROPPATCH':
          // Proprietà custom non persistite: rispondi ok (client Windows/macOS le mandano)
          res.status(207).type('application/xml');
          return res.send('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>' +
            xmlEsc(req.path) + '</D:href><D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>');

        case 'LOCK': {
          // Lock fittizio classe 2 (richiesto da Windows/macOS per aprire in scrittura)
          const token = `opaquelocktoken:${crypto.randomUUID()}`;
          res.setHeader('lock-token', `<${token}>`);
          res.status(200).type('application/xml');
          return res.send(`<?xml version="1.0"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>
<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>
<D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>
<D:locktoken><D:href>${token}</D:href></D:locktoken>
</D:activelock></D:lockdiscovery></D:prop>`);
        }
        case 'UNLOCK':
          return res.status(204).end();

        default:
          return res.status(405).end();
      }
    } catch (e) {
      const code = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EEXIST' ? 405 : 500);
      if (code >= 500) log.warn('[webdav]', e.message);
      res.status(code).type('text/plain').send(e.message);
    }
  };
}
