// Helper effimero di self-update: UnraidDeck non può ricrearsi da solo, quindi
// spawna questo processo in un container detached (stessa immagine, AutoRemove,
// label net.unraiddeck.helper=1) che esegue i passi 1–6 della procedura di
// update sul container UnraidDeck indicato e termina.
import { initDb, closeDb } from './core/db.js';
import { initCrypto } from './core/crypto.js';
import { initDocker } from './docker/manager.js';
import { updateContainer } from './docker/updates.js';
import { log, sleep } from './core/util.js';

async function main() {
  const targetId = process.argv[2];
  if (!targetId) {
    log.error('[updater] uso: node updater.js <containerId>');
    process.exit(2);
  }
  log.info(`[updater] helper self-update per ${targetId.slice(0, 12)}`);

  // Piccola attesa: lascia che il deck finisca di rispondere alla richiesta API
  await sleep(2000);

  initDb();
  initCrypto();
  await initDocker();

  try {
    const out = await updateContainer(targetId, { allowSelf: true }, 'updater-helper');
    log.info(`[updater] esito: ${out.status}`);
    closeDb();
    process.exit(0);
  } catch (e) {
    log.error('[updater] update fallito:', e.message);
    closeDb();
    process.exit(1);
  }
}

main().catch((e) => {
  log.error('[updater] errore fatale:', e.stack || e.message);
  process.exit(1);
});
