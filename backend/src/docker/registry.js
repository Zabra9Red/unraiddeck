// Check aggiornamenti via Registry HTTP API v2: HEAD sui manifest (le HEAD non
// contano nei rate limit Docker Hub), token anonimo o credenziali per-registry,
// timeout 10s, concorrenza p-limit(4), backoff per-registry su 429, cache SQLite.
import pLimit from 'p-limit';
import { db, getSetting } from '../core/db.js';
import { decrypt } from '../core/crypto.js';
import { log } from '../core/util.js';

// Tutti i media type, inclusi i single-manifest: i repo single-arch altrimenti
// rischiano fallback schema1 → digest sbagliato.
const ACCEPT = [
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

const HEAD_TIMEOUT = 10000;
const limit = pLimit(4);

const tokenCache = new Map();     // `${registry}|${repo}` -> { token, exp }
const registryBackoff = new Map(); // registry -> { fails, nextTs }

// ---- Parsing riferimenti immagine ----
// Forme: nginx | user/repo:tag | ghcr.io/owner/repo:tag | host:5000/repo | repo@sha256:...
export function parseImageRef(ref) {
  let rest = ref;
  let digest = null;
  const atIdx = rest.indexOf('@');
  if (atIdx >= 0) { digest = rest.slice(atIdx + 1); rest = rest.slice(0, atIdx); }

  let registry = 'docker.io';
  const firstSlash = rest.indexOf('/');
  if (firstSlash >= 0) {
    const first = rest.slice(0, firstSlash);
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      registry = first;
      rest = rest.slice(firstSlash + 1);
    }
  }
  let tag = 'latest';
  const colonIdx = rest.lastIndexOf(':');
  if (colonIdx >= 0 && !rest.slice(colonIdx).includes('/')) {
    tag = rest.slice(colonIdx + 1);
    rest = rest.slice(0, colonIdx);
  }
  let repo = rest;
  if (registry === 'docker.io' && !repo.includes('/')) repo = `library/${repo}`;
  return { registry, repo, tag, digest };
}

function registryHost(registry) {
  return registry === 'docker.io' ? 'registry-1.docker.io' : registry;
}

// ---- Credenziali per-registry (cifrate at-rest) ----
export function getRegistryCreds(registry) {
  const row = db.prepare('SELECT * FROM registry_creds WHERE registry = ?').get(registry);
  if (!row) return null;
  try {
    return { username: row.username, password: decrypt(row.password_enc) };
  } catch {
    return null;
  }
}

// authconfig per dockerode pull.
export function authConfigFor(imageRef) {
  const { registry } = parseImageRef(imageRef);
  const creds = getRegistryCreds(registry);
  if (!creds) return undefined;
  return { username: creds.username, password: creds.password, serveraddress: registryHost(registry) };
}

// ---- Backoff per-registry su 429 ----
function backoffActive(registry) {
  const st = registryBackoff.get(registry);
  return st && Date.now() < st.nextTs;
}
function backoffHit(registry) {
  const st = registryBackoff.get(registry) || { fails: 0, nextTs: 0 };
  st.fails += 1;
  st.nextTs = Date.now() + Math.min(3600000, 60000 * 2 ** (st.fails - 1)); // 1m → 1h
  registryBackoff.set(registry, st);
  log.warn(`[registry] 429 da ${registry}, backoff fino a ${new Date(st.nextTs).toISOString()}`);
}
function backoffClear(registry) {
  registryBackoff.delete(registry);
}

// ---- Token bearer generico via WWW-Authenticate ----
async function fetchWithTimeout(url, opts = {}, ms = HEAD_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(t);
  }
}

async function getToken(registry, repo) {
  const key = `${registry}|${repo}`;
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.exp) return cached.token;

  // Scopri realm/service dal 401 (flusso generico: funziona per Hub, ghcr, lscr, quay…)
  const probeUrl = `https://${registryHost(registry)}/v2/${repo}/manifests/latest`;
  const probe = await fetchWithTimeout(probeUrl, { method: 'HEAD', headers: { accept: ACCEPT } });
  if (probe.status !== 401) return null; // registry senza auth
  const wa = probe.headers.get('www-authenticate') || '';
  const m = wa.match(/Bearer\s+(.*)/i);
  if (!m) return null;
  const params = {};
  for (const kv of m[1].match(/(\w+)="([^"]*)"/g) || []) {
    const [, k, v] = kv.match(/(\w+)="([^"]*)"/);
    params[k] = v;
  }
  if (!params.realm) return null;
  const url = new URL(params.realm);
  if (params.service) url.searchParams.set('service', params.service);
  url.searchParams.set('scope', params.scope || `repository:${repo}:pull`);

  const headers = {};
  const creds = getRegistryCreds(registry);
  if (creds) headers.authorization = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');

  const res = await fetchWithTimeout(url, { headers });
  if (!res.ok) throw new Error(`token ${registry}: HTTP ${res.status}`);
  const body = await res.json();
  const token = body.token || body.access_token;
  tokenCache.set(key, { token, exp: Date.now() + ((body.expires_in || 300) - 60) * 1000 });
  return token;
}

// HEAD manifest → digest remoto (header Docker-Content-Digest).
async function remoteDigest(registry, repo, tag) {
  const token = await getToken(registry, repo);
  const headers = { accept: ACCEPT };
  if (token) headers.authorization = `Bearer ${token}`;
  const url = `https://${registryHost(registry)}/v2/${repo}/manifests/${tag}`;
  const res = await fetchWithTimeout(url, { method: 'HEAD', headers });
  if (res.status === 429) { backoffHit(registry); throw new Error('rate limit (429)'); }
  if (!res.ok) throw new Error(`HEAD manifest: HTTP ${res.status}`);
  backoffClear(registry);
  const digest = res.headers.get('docker-content-digest');
  if (!digest) throw new Error('Docker-Content-Digest assente');
  return digest;
}

// ---- Check per singolo container ----
// containerInfo: { image (ref), imageInspect: { RepoDigests, RepoTags } }
// Ritorna { status: 'update'|'current'|'pinned'|'local'|'error', reason?, remoteDigest?, localDigest? }
export async function checkImageUpdate(imageRef, imageInspect) {
  const parsed = parseImageRef(imageRef);

  // Avviati per digest: nessun tag da confrontare → "pinned"
  if (parsed.digest) {
    return { status: 'pinned', reason: 'Container avviato per digest (repo@sha256): nessun tag da confrontare' };
  }
  const repoDigests = imageInspect?.RepoDigests || [];
  const repoTags = imageInspect?.RepoTags || [];
  // Build o import locali: niente digest/tag remoti → "locale"
  if (repoDigests.length === 0) {
    return {
      status: 'local',
      reason: repoTags.length === 0
        ? 'Immagine senza RepoTags/RepoDigests (import locale)'
        : 'Immagine costruita/importata localmente: nessun digest di registry',
    };
  }
  if (backoffActive(parsed.registry)) {
    return { status: 'error', reason: `Backoff attivo su ${parsed.registry} (rate limit), riprovare più tardi` };
  }

  const localDigests = repoDigests.map(d => d.split('@')[1]).filter(Boolean);
  try {
    const remote = await limit(() => remoteDigest(parsed.registry, parsed.repo, parsed.tag));
    const status = localDigests.includes(remote) ? 'current' : 'update';
    return { status, remoteDigest: remote, localDigest: localDigests[0] };
  } catch (e) {
    return { status: 'error', reason: e.message };
  }
}

// ---- Cache SQLite ----
export function cacheUpdateResult(imageRef, result) {
  db.prepare(`INSERT INTO update_cache (image_ref, local_digest, remote_digest, status, reason, checked_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(image_ref) DO UPDATE SET local_digest=excluded.local_digest,
                remote_digest=excluded.remote_digest, status=excluded.status,
                reason=excluded.reason, checked_at=excluded.checked_at`)
    .run(imageRef, result.localDigest || null, result.remoteDigest || null,
      result.status, result.reason || null, Date.now());
}
export function cachedUpdateResult(imageRef) {
  const row = db.prepare('SELECT * FROM update_cache WHERE image_ref = ?').get(imageRef);
  if (!row) return null;
  return { status: row.status, reason: row.reason, remoteDigest: row.remote_digest, localDigest: row.local_digest, checkedAt: row.checked_at };
}
export function allCachedResults() {
  const out = {};
  for (const row of db.prepare('SELECT * FROM update_cache').all()) {
    out[row.image_ref] = { status: row.status, reason: row.reason, checkedAt: row.checked_at };
  }
  return out;
}
export function invalidateUpdateCache(imageRef) {
  db.prepare('DELETE FROM update_cache WHERE image_ref = ?').run(imageRef);
}
