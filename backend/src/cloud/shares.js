// Link di condivisione pubblici (funzione Nextcloud/Filebrowser share):
// token random, scadenza opzionale, password opzionale (bcrypt), contatore
// download. Pagina pubblica /s/<token> senza sessione: file → download,
// cartella → listing HTML minimale (sotto-percorsi validati).
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../core/db.js';
import { resolveSafe, streamRaw } from '../files/local-fs.js';
import { log } from '../core/util.js';

export function createShare(filePath, user, { expiresHours = null, password = null } = {}) {
  const token = crypto.randomBytes(16).toString('base64url');
  db.prepare(`INSERT INTO cloud_shares (token, path, created_by, created_at, exp, password_hash, downloads)
              VALUES (?, ?, ?, ?, ?, ?, 0)`)
    .run(token, filePath, user, Date.now(),
      expiresHours ? Date.now() + expiresHours * 3600000 : null,
      password ? bcrypt.hashSync(password, 10) : null);
  return token;
}

export function listShares(user) {
  db.prepare('DELETE FROM cloud_shares WHERE exp IS NOT NULL AND exp < ?').run(Date.now());
  return db.prepare('SELECT token, path, created_at, exp, password_hash IS NOT NULL AS locked, downloads FROM cloud_shares WHERE created_by = ? ORDER BY created_at DESC').all(user);
}

export function deleteShare(token, user) {
  return db.prepare('DELETE FROM cloud_shares WHERE token = ? AND created_by = ?').run(token, user).changes > 0;
}

function getShare(token) {
  const s = db.prepare('SELECT * FROM cloud_shares WHERE token = ?').get(token);
  if (!s) return null;
  if (s.exp && s.exp < Date.now()) { db.prepare('DELETE FROM cloud_shares WHERE token = ?').run(token); return null; }
  return s;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PAGE = (title, body) => `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — UnraidDeck</title>
<style>body{font-family:system-ui;background:#1e1e2e;color:#cdd6f4;max-width:720px;margin:2rem auto;padding:0 1rem}
a{color:#89b4fa;text-decoration:none}a:hover{text-decoration:underline}
.card{background:#181825;border:1px solid #313244;border-radius:12px;padding:1.2rem}
input,button{font:inherit;padding:.4rem .8rem;border-radius:8px;border:1px solid #45475a;background:#11111b;color:#cdd6f4}
button{background:#89b4fa;color:#11111b;border:none;cursor:pointer}
li{padding:.25rem 0;list-style:none}ul{padding:0}
.muted{color:#6c7086;font-size:.85rem}</style></head><body><div class="card">${body}</div>
<p class="muted" style="text-align:center">UnraidDeck</p></body></html>`;

function needsPassword(s, req) {
  if (!s.password_hash) return false;
  const given = req.query.pw || req.body?.pw;
  return !(given && bcrypt.compareSync(String(given), s.password_hash));
}

const pwForm = (token) => PAGE('Protetto', `<h2>Contenuto protetto</h2>
<form method="post" action="/s/${esc(token)}"><p><input type="password" name="pw" placeholder="Password" autofocus>
<button>Apri</button></p></form>`);

// GET/POST /s/:token[?f=relativo]
export async function serveShare(req, res) {
  const s = getShare(req.params.token);
  if (!s) return res.status(404).send(PAGE('Non trovato', '<h2>Link inesistente o scaduto</h2>'));
  if (needsPassword(s, req)) return res.status(s.password_hash && (req.query.pw || req.body?.pw) ? 403 : 401).send(pwForm(req.params.token));
  const pwq = (req.query.pw || req.body?.pw) ? `pw=${encodeURIComponent(req.query.pw || req.body.pw)}&` : '';

  let target = await resolveSafe(s.path);
  const st0 = await fsp.stat(target);
  if (st0.isDirectory() && req.query.f) {
    // Sotto-percorso: DEVE restare dentro la cartella condivisa
    const sub = path.posix.normalize(String(req.query.f));
    if (sub.split('/').includes('..')) return res.status(400).end();
    target = await resolveSafe(path.join(s.path, sub));
    if (target !== s.path && !target.startsWith(s.path + '/')) return res.status(400).end();
  }

  const st = await fsp.stat(target);
  if (st.isDirectory()) {
    const entries = (await fsp.readdir(target, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith('.'))
      .sort((a, b) => (a.isDirectory() ? 0 : 1) - (b.isDirectory() ? 0 : 1) || a.name.localeCompare(b.name));
    const rel = target === s.path ? '' : target.slice(s.path.length + 1);
    const rows = entries.map((e) => {
      const child = rel ? `${rel}/${e.name}` : e.name;
      return `<li>${e.isDirectory() ? '📁' : '📄'} <a href="/s/${esc(s.token)}?${pwq}f=${encodeURIComponent(child)}">${esc(e.name)}</a></li>`;
    }).join('');
    const up = rel ? `<li>⬆️ <a href="/s/${esc(s.token)}?${pwq}f=${encodeURIComponent(rel.split('/').slice(0, -1).join('/'))}">..</a></li>` : '';
    return res.send(PAGE(path.basename(s.path), `<h2>📁 ${esc(path.basename(s.path))}${rel ? ' / ' + esc(rel) : ''}</h2><ul>${up}${rows || '<li class="muted">vuota</li>'}</ul>`));
  }

  db.prepare('UPDATE cloud_shares SET downloads = downloads + 1 WHERE token = ?').run(s.token);
  log.info(`[share] download ${target} (token ${s.token.slice(0, 8)}…)`);
  res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`);
  await streamRaw(target, req, res);
}
