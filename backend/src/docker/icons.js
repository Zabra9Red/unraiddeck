// Proxy icone (label net.unraid.docker.icon): cache su disco in /config/icons
// (funziona offline, niente mixed-content dietro HTTPS). Guard-rail anti-SSRF:
// solo http/https, timeout 5s, ≤1MB, ≤3 redirect, content-type image/*.
// Servite con content-type fisso + nosniff. Cache LRU con cap 50MB.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import { db } from '../core/db.js';
import { config } from '../core/config.js';
import { sha256hex } from '../core/crypto.js';
import { log } from '../core/util.js';

const MAX_SIZE = 1024 * 1024;        // 1 MB per icona
const CACHE_CAP = 50 * 1024 * 1024;  // 50 MB totali (LRU)
const FETCH_TIMEOUT = 5000;
const MAX_REDIRECTS = 3;

function iconDir() { return path.join(config.configDir, 'icons'); }

// Blocca IP che puntano a metadata endpoint cloud / range speciali di abuso.
// NB: le icone possono legittimamente stare sulla LAN (server Unraid stesso),
// quindi i range privati NON vengono bloccati; bloccati loopback esterni al
// deck, link-local e metadata (169.254.0.0/16).
function isForbiddenIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 0) return true;
  } else if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low.startsWith('fe80') || low === '::' ) return true;
  }
  return false;
}

async function guardedFetch(rawUrl) {
  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Solo http/https ammessi');
    // Risolvi e verifica l'host prima della fetch
    const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (net.isIP(u.hostname) ? isForbiddenIp(u.hostname) : addrs.some(a => isForbiddenIp(a.address))) {
      throw new Error('Host non ammesso');
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, { redirect: 'manual', signal: ctrl.signal });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('Redirect senza Location');
        url = new URL(loc, url).href;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!ct.startsWith('image/')) throw new Error(`Content-type non immagine: ${ct}`);
      const len = parseInt(res.headers.get('content-length') || '0', 10);
      if (len > MAX_SIZE) throw new Error('Icona oltre 1MB');
      // Leggi con cap dimensione anche senza content-length
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_SIZE) { reader.cancel().catch(() => {}); throw new Error('Icona oltre 1MB'); }
        chunks.push(value);
      }
      return { buffer: Buffer.concat(chunks), contentType: ct };
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(`Troppi redirect (>${MAX_REDIRECTS})`);
}

// Eviction LRU fino a rientrare nel cap 50MB.
function evictLru() {
  const total = db.prepare('SELECT COALESCE(SUM(size),0) AS s FROM icon_cache').get().s;
  if (total <= CACHE_CAP) return;
  const rows = db.prepare('SELECT * FROM icon_cache ORDER BY last_used ASC').all();
  let cur = total;
  for (const row of rows) {
    if (cur <= CACHE_CAP) break;
    try { fs.unlinkSync(path.join(iconDir(), row.file)); } catch { /* già assente */ }
    db.prepare('DELETE FROM icon_cache WHERE url_hash = ?').run(row.url_hash);
    cur -= row.size;
  }
}

// Handler Express: GET /api/icons?url=…
export async function serveIcon(req, res) {
  const url = String(req.query.url || '');
  if (!url) return res.status(400).json({ error: 'url mancante' });
  const hash = sha256hex(url);
  const now = Date.now();

  const cached = db.prepare('SELECT * FROM icon_cache WHERE url_hash = ?').get(hash);
  if (cached && !req.query.refresh) {
    const file = path.join(iconDir(), cached.file);
    if (fs.existsSync(file)) {
      db.prepare('UPDATE icon_cache SET last_used = ? WHERE url_hash = ?').run(now, hash);
      res.setHeader('content-type', cached.content_type);
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('cache-control', 'public, max-age=86400');
      return fs.createReadStream(file).pipe(res);
    }
    db.prepare('DELETE FROM icon_cache WHERE url_hash = ?').run(hash);
  }

  try {
    const { buffer, contentType } = await guardedFetch(url);
    const file = `${hash}.img`;
    fs.writeFileSync(path.join(iconDir(), file), buffer);
    db.prepare(`INSERT INTO icon_cache (url_hash, url, file, content_type, size, fetched_at, last_used)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url_hash) DO UPDATE SET file=excluded.file, content_type=excluded.content_type,
                  size=excluded.size, fetched_at=excluded.fetched_at, last_used=excluded.last_used`)
      .run(hash, url, file, contentType, buffer.length, now, now);
    evictLru();
    res.setHeader('content-type', contentType);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'public, max-age=86400');
    res.end(buffer);
  } catch (e) {
    log.warn(`[icons] fetch fallita ${url}:`, e.message);
    res.status(502).json({ error: `Icona non recuperabile: ${e.message}` });
  }
}
