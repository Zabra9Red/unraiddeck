// Galleria foto/video (funzione "Immich-like", senza ML): scansione bounded
// delle share, thumbnail via vipsthumbnail/ffmpeg con cache su /config.
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import pLimit from 'p-limit';
import { config } from '../core/config.js';
import { resolveSafe } from '../files/local-fs.js';

const IMG = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'heic', 'heif', 'tif', 'tiff']);
const VID = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', '3gp', 'mts', 'm2ts']);
const MAX_ITEMS = 5000;
const MAX_DEPTH = 6;
const thumbLimit = pLimit(2);

export async function scanMedia(dir) {
  const root = await resolveSafe(dir);
  const items = [];
  async function walk(p, depth) {
    if (items.length >= MAX_ITEMS || depth > MAX_DEPTH) return;
    let entries;
    try { entries = await fsp.readdir(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (items.length >= MAX_ITEMS) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(p, e.name);
      if (e.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      const ext = e.name.includes('.') ? e.name.split('.').pop().toLowerCase() : '';
      const kind = IMG.has(ext) ? 'image' : VID.has(ext) ? 'video' : null;
      if (!kind) continue;
      try {
        const st = await fsp.stat(full);
        items.push({ path: full, name: e.name, mtime: st.mtimeMs, size: st.size, kind });
      } catch { /* sparito */ }
    }
  }
  await walk(root, 0);
  items.sort((a, b) => b.mtime - a.mtime);
  return { items, truncated: items.length >= MAX_ITEMS };
}

const thumbsDir = () => path.join(config.configDir, 'cache', 'thumbs');

function run(bin, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout }, (e) => e ? reject(e) : resolve());
  });
}

// Thumbnail 256px webp, cache per path+mtime. Immagini: vipsthumbnail
// (heic/tiff inclusi); video: frame via ffmpeg.
export async function thumbFor(p, kind) {
  const st = await fsp.stat(p);
  const key = crypto.createHash('sha1').update(`${p}|${Math.round(st.mtimeMs)}`).digest('hex');
  const out = path.join(thumbsDir(), `${key}.webp`);
  if (fs.existsSync(out)) return out;
  await fsp.mkdir(thumbsDir(), { recursive: true });
  await thumbLimit(async () => {
    if (fs.existsSync(out)) return;
    const tmp = `${out}.tmp-${process.pid}`;
    try {
      if (kind === 'video') {
        await run('ffmpeg', ['-y', '-ss', '1', '-i', p, '-frames:v', '1', '-vf', 'scale=256:-2', '-f', 'webp', tmp], 60000);
      } else {
        await run('vipsthumbnail', [p, '-s', '256', '-o', `${tmp}[Q=75,strip]`]);
      }
      await fsp.rename(tmp, out);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
  });
  return out;
}
