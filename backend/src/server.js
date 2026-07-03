// UnraidDeck — entrypoint server. Un solo container, zero dipendenze esterne.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { Server as SocketIo } from 'socket.io';

import { config } from './core/config.js';
import { initDb, closeDb, scheduleBackups, db } from './core/db.js';
import { initCrypto } from './core/crypto.js';
import * as auth from './core/auth.js';
import { pruneAudit } from './core/audit.js';
import { bindNotifyIo, pruneNotifications } from './core/notify.js';
import { initDocker, gcHelpers } from './docker/manager.js';
import { startEvents, stopEvents } from './docker/events.js';
import { stopStatsHub } from './docker/stats-hub.js';
import { stopAllLogStreams } from './docker/logs.js';
import { closeAllExecSessions } from './docker/exec.js';
import { recoverJournal, scheduleUpdateChecks, stopUpdateChecks, bindUpdatesIo } from './docker/updates.js';
import { initUnraid, stopUnraid } from './unraid/poller.js';
import { buildRouter } from './api/routes.js';
import { initSockets } from './api/sockets.js';
import { log } from './core/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  log.info(`UnraidDeck v${config.version} — avvio…`);

  // Core
  initDb();
  initCrypto();
  auth.bootstrapFromEnv();
  scheduleBackups();
  if (config.disableAuth) log.warn('[auth] DISABLE_AUTH=true — accesso senza autenticazione (solo LAN!)');

  // Express
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) {
    // "true"/"1" → 1 hop; altrimenti valore passato a Express (loopback, IP, ...)
    app.set('trust proxy', ['true', '1'].includes(config.trustProxy.toLowerCase()) ? 1 : config.trustProxy);
  }

  // CSP restrittiva self-only, compatibile con la build Vite
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // xterm/tailwind inline styles
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use('/api', auth.originCheck, buildRouter());

  // Frontend statico (build Vite) con fallback SPA
  const dist = path.resolve(__dirname, '../../frontend/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: 'index.html', maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    log.warn('[server] frontend/dist non trovato: solo API');
  }

  // Error handler JSON
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log.error('[api]', err.message);
    res.status(status).json({ error: err.message || 'Errore interno' });
  });

  const server = http.createServer(app);
  const io = new SocketIo(server, { path: '/socket.io' });
  bindNotifyIo(io);
  bindUpdatesIo(io);
  initSockets(io);

  // Docker: negoziazione versione API, GC helper zombie, recovery journal, events
  await initDocker();
  await gcHelpers();
  await recoverJournal();
  startEvents(io);
  scheduleUpdateChecks();

  // Unraid: introspection GraphQL → capability map, oppure fallback SSH
  await initUnraid(io);

  // Retention periodiche (audit 90gg/20k, notifiche 90gg, sessioni scadute)
  const pruneTimer = setInterval(() => {
    try { pruneAudit(); pruneNotifications(); auth.pruneSessions(); } catch (e) { log.warn('[prune]', e.message); }
  }, 6 * 3600000);
  pruneTimer.unref();

  server.listen(config.port, () => {
    log.info(`[server] in ascolto su :${config.port}`);
  });

  // Gestione SIGTERM/SIGINT: chiusura pulita di stream, exec, SSH, checkpoint WAL
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[server] ${signal} ricevuto, chiusura pulita…`);
    const hardExit = setTimeout(() => { log.warn('[server] chiusura forzata'); process.exit(1); }, 10000);
    hardExit.unref();
    try {
      stopUpdateChecks();
      stopEvents();
      stopStatsHub();
      stopAllLogStreams();
      closeAllExecSessions();
      stopUnraid();
      io.close();
      await new Promise((r) => server.close(r));
      closeDb(); // checkpoint WAL + close
      log.info('[server] arrestato');
      process.exit(0);
    } catch (e) {
      log.error('[server] errore in chiusura:', e.message);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('[server] avvio fallito:', e.stack || e.message);
  process.exit(1);
});
