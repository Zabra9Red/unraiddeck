// Sync del template dockerman: le release nuove aggiungono variabili/mount al
// template CA, ma Unraid tiene la copia dell'utente su /boot e i container già
// installati non le vedono ("devo metterle a mano"). All'avvio confrontiamo il
// template canonico (dentro l'immagine) con la copia utente via SSH e
// AGGIUNGIAMO le <Config> mancanti (match per attributo Target), senza toccare
// i valori esistenti. Le novità si attivano al prossimo Apply del container —
// la notifica lo dice. Best-effort: senza SSH non fa nulla.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sshConfigured, sshExec } from './ssh-fallback.js';
import { notify } from '../core/notify.js';
import { audit } from '../core/audit.js';
import { log } from '../core/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = '/boot/config/plugins/dockerMan/templates-user';
const REPO_MATCH = 'zabra9red/unraiddeck';

function canonicalPath() {
  // In immagine: /app/docker/my-UnraidDeck.xml; in dev: ../../..//docker/
  for (const p of [
    path.resolve(__dirname, '../../../docker/my-UnraidDeck.xml'),
    '/app/docker/my-UnraidDeck.xml',
  ]) if (fs.existsSync(p)) return p;
  return null;
}

// Estrae le <Config> (self-closed o con valore) con l'attributo Target.
function parseConfigs(xml) {
  const out = [];
  const rx = /<Config\b[^>]*?\/>|<Config\b[^>]*?>[\s\S]*?<\/Config>/g;
  for (const m of xml.matchAll(rx)) {
    const tag = m[0];
    const target = /\bTarget="([^"]*)"/.exec(tag)?.[1];
    const name = /\bName="([^"]*)"/.exec(tag)?.[1];
    if (target !== undefined) out.push({ tag, target, name: name || target });
  }
  return out;
}

// Pura e testabile: aggiunge al template utente le Config canoniche mancanti.
export function mergeTemplates(userXml, canonicalXml) {
  const userTargets = new Set(parseConfigs(userXml).map((c) => c.target));
  const missing = parseConfigs(canonicalXml).filter((c) => !userTargets.has(c.target));
  if (!missing.length) return { merged: userXml, added: [] };
  const insertion = missing.map((c) => `  ${c.tag}`).join('\n');
  const merged = userXml.includes('</Container>')
    ? userXml.replace('</Container>', `${insertion}\n</Container>`)
    : userXml + '\n' + insertion + '\n';
  return { merged, added: missing.map((c) => c.name) };
}

export async function syncUserTemplates() {
  if (!sshConfigured()) return;
  const canonical = canonicalPath();
  if (!canonical) return log.warn('[template-sync] template canonico non trovato nell\'immagine');
  const canonicalXml = fs.readFileSync(canonical, 'utf8');
  try {
    const { stdout } = await sshExec(`grep -li '${REPO_MATCH}' ${TEMPLATES_DIR}/*.xml 2>/dev/null || true`);
    const files = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    for (const file of files) {
      const { stdout: userXml, code } = await sshExec(`cat '${file.replace(/'/g, `'\\''`)}'`);
      if (code !== 0 || !userXml.includes('<Container')) continue;
      const { merged, added } = mergeTemplates(userXml, canonicalXml);
      if (!added.length) continue;
      // Backup una tantum, poi scrittura atomica (base64 per il quoting)
      const esc = file.replace(/'/g, `'\\''`);
      await sshExec(`[ -f '${esc}.bak-unraiddeck' ] || cp '${esc}' '${esc}.bak-unraiddeck'`);
      const b64 = Buffer.from(merged).toString('base64');
      const { code: wc, stderr } = await sshExec(`echo '${b64}' | base64 -d > '${esc}.tmp' && mv '${esc}.tmp' '${esc}'`);
      if (wc !== 0) throw new Error(stderr || `exit ${wc}`);
      log.info(`[template-sync] ${path.basename(file)}: aggiunte ${added.length} voci (${added.join(', ')})`);
      audit('sistema', 'template.sync', path.basename(file), 'ok', null, added.join(', '));
      notify('template-sync', 'info', 'Template Unraid aggiornato',
        `Nuove voci aggiunte al template del container: ${added.join(', ')}. Apri il container → Apply per attivarle (i valori esistenti non sono stati toccati).`,
        { force: true });
    }
  } catch (e) {
    log.warn('[template-sync] fallito:', e.message);
  }
}
