// HTTPS nativo (LAN): con HTTPS=true il server parla TLS sulla porta
// principale. Certificati da /config/certs (cert.pem + key.pem); se mancano
// vengono GENERATI self-signed una tantum con openssl (presente nell'immagine).
// Per un certificato tuo: sostituisci i file e riavvia.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config.js';
import { ensureAcmeCert } from './acme.js';
import { log } from './util.js';

export async function ensureCerts() {
  // DuckDNS configurato → certificato Let's Encrypt vero (niente avvisi browser)
  if (config.duckdnsDomain && config.duckdnsToken) {
    try {
      const { cert, key } = await ensureAcmeCert();
      log.info(`[tls] certificato Let's Encrypt attivo — apri https://${config.duckdnsDomain}.duckdns.org:${config.port}`);
      return { cert, key };
    } catch (e) {
      log.warn('[tls] Let\'s Encrypt fallito, ripiego sul self-signed:', e.message);
    }
  }
  return ensureLocalCa();
}

// CA privata "UnraidDeck Local CA" + certificato server firmato con SAN
// IP:<UNRAID_HOST>, IP:127.0.0.1, DNS:unraiddeck.local, DNS:localhost.
// Installando la CA sul telefono (una volta) il lucchetto è verde anche
// su https://IP:8787 — vedi il pulsante "Scarica certificato CA" in Settings.
export function caPaths() {
  const dir = path.join(config.configDir, 'certs');
  return {
    caKey: path.join(dir, 'ca.key'),
    caCert: path.join(dir, 'ca.pem'),
    key: path.join(dir, 'server.key'),
    cert: path.join(dir, 'server.pem'),
  };
}

function sanList() {
  const san = ['IP:127.0.0.1', 'DNS:localhost', 'DNS:unraiddeck.local'];
  if (config.unraidHost && /^\d+\.\d+\.\d+\.\d+$/.test(config.unraidHost)) san.push(`IP:${config.unraidHost}`);
  else if (config.unraidHost) san.push(`DNS:${config.unraidHost}`);
  return san.join(',');
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('openssl', args, { timeout: 30000 }, (e, _o, stderr) =>
      e ? reject(new Error(`openssl: ${stderr || e.message}`)) : resolve());
  });
}

async function ensureLocalCa() {
  const p = caPaths();
  fs.mkdirSync(path.dirname(p.caCert), { recursive: true });

  if (!fs.existsSync(p.caCert) || !fs.existsSync(p.caKey)) {
    log.info('[tls] genero la CA locale (10 anni) in', path.dirname(p.caCert));
    await run(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
      '-keyout', p.caKey, '-out', p.caCert,
      '-subj', '/CN=UnraidDeck Local CA/O=UnraidDeck',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    fs.chmodSync(p.caKey, 0o600);
    // CA nuova ⇒ il cert server va riemesso
    fs.rmSync(p.cert, { force: true });
  }

  // Riemetti il cert server se assente o se la SAN non copre l'IP corrente
  let needServer = !fs.existsSync(p.cert) || !fs.existsSync(p.key);
  if (!needServer && config.unraidHost) {
    try {
      const x = new (await import('node:crypto')).X509Certificate(fs.readFileSync(p.cert));
      if (!(x.subjectAltName || '').includes(config.unraidHost)) needServer = true;
      if (new Date(x.validTo).getTime() - Date.now() < 30 * 86400000) needServer = true;
    } catch { needServer = true; }
  }
  if (needServer) {
    log.info('[tls] emetto il certificato server (SAN:', sanList(), ')');
    const csr = p.cert + '.csr';
    const ext = p.cert + '.ext';
    fs.writeFileSync(ext, [
      'basicConstraints=CA:FALSE',
      'keyUsage=digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${sanList()}`,
      '',
    ].join('\n'));
    try {
      await run(['genrsa', '-out', p.key, '2048']);
      fs.chmodSync(p.key, 0o600);
      await run(['req', '-new', '-sha256', '-key', p.key, '-subj', '/CN=UnraidDeck', '-out', csr]);
      await run(['x509', '-req', '-sha256', '-days', '825', '-in', csr,
        '-CA', p.caCert, '-CAkey', p.caKey, '-CAcreateserial',
        '-out', p.cert, '-extfile', ext]);
    } finally {
      fs.rmSync(csr, { force: true });
      fs.rmSync(ext, { force: true });
    }
  }
  return { cert: fs.readFileSync(p.cert), key: fs.readFileSync(p.key) };
}
