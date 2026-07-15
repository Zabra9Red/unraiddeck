// HTTPS nativo (LAN): con HTTPS=true il server parla TLS sulla porta
// principale. Certificati da /config/certs (cert.pem + key.pem); se mancano
// vengono GENERATI self-signed una tantum con openssl (presente nell'immagine).
// Per un certificato tuo: sostituisci i file e riavvia.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config.js';
import { log } from './util.js';

export async function ensureCerts() {
  const dir = path.join(config.configDir, 'certs');
  const certPath = config.httpsCert || path.join(dir, 'cert.pem');
  const keyPath = config.httpsKey || path.join(dir, 'key.pem');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(certPath), { recursive: true });
    log.info('[tls] certificato assente: genero un self-signed (10 anni) in', path.dirname(certPath));
    await new Promise((resolve, reject) => {
      execFile('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-subj', '/CN=UnraidDeck',
        '-addext', `subjectAltName=DNS:unraiddeck,DNS:localhost,IP:127.0.0.1${config.unraidHost ? `,IP:${config.unraidHost}` : ''}`,
      ], { timeout: 30000 }, (e, _o, stderr) => e ? reject(new Error(`openssl: ${stderr || e.message}`)) : resolve());
    });
    fs.chmodSync(keyPath, 0o600);
  }
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}
