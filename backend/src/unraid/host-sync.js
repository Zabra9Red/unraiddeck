// Sincronizzazione con dockerman di Unraid: dopo un update fatto da UnraidDeck
// la pagina Docker di Unraid mostrerebbe ancora "update ready" perché la sua
// cache (/var/lib/docker/unraid-update-status.json) non sa nulla del pull.
// Qui la patchiamo via SSH: digest nuovo su local+remote e status "true".
// Best-effort: senza SSH configurato (o non-Unraid) non fa nulla.
import { sshConfigured, sshExec } from './ssh-fallback.js';
import { log } from '../core/util.js';

const STATUS_FILE = '/var/lib/docker/unraid-update-status.json';

// Pura e testabile: patcha il JSON della cache dockerman.
export function patchStatusJson(text, imageRef, digest) {
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) data = {};
  const withTag = /:[^/]+$/.test(imageRef) ? imageRef : `${imageRef}:latest`;
  // dockerman può aver salvato la chiave con o senza registry di default
  const candidates = new Set([withTag]);
  if (withTag.startsWith('docker.io/')) candidates.add(withTag.slice('docker.io/'.length));
  else if (!withTag.includes('/') || !withTag.split('/')[0].includes('.')) candidates.add(`docker.io/${withTag}`);
  let touched = false;
  for (const k of Object.keys(data)) {
    if (candidates.has(k)) {
      data[k] = { ...data[k], local: digest, remote: digest, status: 'true' };
      touched = true;
    }
  }
  if (!touched) data[withTag] = { local: digest, remote: digest, status: 'true' };
  return JSON.stringify(data);
}

export async function syncUnraidUpdateStatus(imageRef, digest) {
  if (!sshConfigured() || !digest) return false;
  try {
    const { stdout } = await sshExec(`cat ${STATUS_FILE} 2>/dev/null || echo {}`);
    const next = patchStatusJson(stdout, imageRef, digest);
    const b64 = Buffer.from(next).toString('base64');
    // Scrittura atomica lato host (tmp + mv)
    const { code, stderr } = await sshExec(`echo '${b64}' | base64 -d > ${STATUS_FILE}.tmp && mv ${STATUS_FILE}.tmp ${STATUS_FILE}`);
    if (code !== 0) throw new Error(stderr || `exit ${code}`);
    log.info(`[host-sync] badge update Unraid azzerato per ${imageRef}`);
    return true;
  } catch (e) {
    log.warn('[host-sync] sync badge Unraid fallita:', e.message);
    return false;
  }
}
