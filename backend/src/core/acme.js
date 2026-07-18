// Client ACME (RFC 8555) minimale per Let's Encrypt con challenge DNS-01 via
// DuckDNS: certificato VERO per <sub>.duckdns.org senza aprire porte (niente
// avvisi "Non sicuro" su Safari/Chrome). Chiavi e CSR via openssl (in
// immagine), JWS RS256 con crypto nativo. Rinnovo: vedi scheduleAcmeRenewal.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { config } from './config.js';
import { log } from './util.js';

const DIRECTORY_URL = process.env.ACME_STAGING === 'true'
  ? 'https://acme-staging-v02.api.letsencrypt.org/directory'
  : 'https://acme-v02.api.letsencrypt.org/directory';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sh(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30000 }, (e, stdout, stderr) =>
      e ? reject(new Error(`${bin}: ${stderr || e.message}`)) : resolve(stdout));
  });
}

function acmeDir() {
  const d = path.join(config.configDir, 'certs', 'acme');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function ensureKey(file) {
  if (!fs.existsSync(file)) {
    await sh('openssl', ['genrsa', '-out', file, '2048']);
    fs.chmodSync(file, 0o600);
  }
  return fs.readFileSync(file, 'utf8');
}

function jwkFromPem(pem) {
  const { n, e, kty } = crypto.createPublicKey(pem).export({ format: 'jwk' });
  return { e, kty, n };
}
export function thumbprint(jwk) {
  // RFC 7638: JSON canonico con chiavi ordinate e,kty,n
  return b64u(crypto.createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest());
}
function signJws(accountKeyPem, protectedHeader, payload) {
  const p = b64u(JSON.stringify(protectedHeader));
  const pl = payload === '' ? '' : b64u(JSON.stringify(payload));
  const sig = crypto.createSign('RSA-SHA256').update(`${p}.${pl}`).sign(accountKeyPem);
  return JSON.stringify({ protected: p, payload: pl, signature: b64u(sig) });
}

// Client con gestione nonce + retry su badNonce
class Acme {
  constructor(accountKeyPem) {
    this.key = accountKeyPem;
    this.jwk = jwkFromPem(accountKeyPem);
    this.kid = null;
    this.nonce = null;
    this.dir = null;
  }
  async init() {
    this.dir = await (await fetch(DIRECTORY_URL, { signal: AbortSignal.timeout(15000) })).json();
  }
  async freshNonce() {
    const res = await fetch(this.dir.newNonce, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    this.nonce = res.headers.get('replay-nonce');
  }
  async post(url, payload) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.nonce) await this.freshNonce();
      const header = { alg: 'RS256', nonce: this.nonce, url, ...(this.kid ? { kid: this.kid } : { jwk: this.jwk }) };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/jose+json' },
        body: signJws(this.key, header, payload),
        signal: AbortSignal.timeout(30000),
      });
      this.nonce = res.headers.get('replay-nonce');
      const text = await res.text();
      const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
      if (res.status === 400 && body?.type === 'urn:ietf:params:acme:error:badNonce') continue;
      if (res.status >= 400) throw new Error(`ACME ${url}: HTTP ${res.status} ${typeof body === 'object' ? body?.detail || JSON.stringify(body).slice(0, 200) : String(body).slice(0, 200)}`);
      return { res, body };
    }
    throw new Error('ACME: badNonce persistente');
  }
}

async function duckdnsTxt(sub, token, txt) {
  const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(sub)}&token=${encodeURIComponent(token)}&txt=${encodeURIComponent(txt)}`;
  const out = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).text();
  if (out.trim() !== 'OK') throw new Error(`DuckDNS TXT rifiutato: ${out.slice(0, 50)}`);
}

// Punta il record A del dominio all'IP LAN (default DuckDNS = IP pubblico).
export async function duckdnsSetIp(sub, token, ip) {
  const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(sub)}&token=${encodeURIComponent(token)}${ip ? `&ip=${encodeURIComponent(ip)}` : ''}`;
  const out = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).text();
  if (out.trim() !== 'OK') throw new Error(`DuckDNS update rifiutato: ${out.slice(0, 50)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function acmeCertPaths() {
  const d = acmeDir();
  return { cert: path.join(d, 'fullchain.pem'), key: path.join(d, 'domain.key') };
}

export function certDaysLeft(certPath) {
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(certPath));
    return (new Date(x.validTo).getTime() - Date.now()) / 86400000;
  } catch { return -1; }
}

// Emette (o rinnova) il certificato. Ritorna { cert, key } (Buffer PEM).
export async function ensureAcmeCert() {
  const sub = config.duckdnsDomain;
  const token = config.duckdnsToken;
  const domain = `${sub}.duckdns.org`;
  const { cert: certPath, key: domainKeyPath } = acmeCertPaths();

  if (certDaysLeft(certPath) > 30) {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(domainKeyPath), renewed: false };
  }
  log.info(`[acme] richiedo certificato Let's Encrypt per ${domain}…`);

  // Record A → IP LAN (così il dominio risolve in casa)
  await duckdnsSetIp(sub, token, config.unraidHost || null).catch((e) => log.warn('[acme] set IP DuckDNS:', e.message));

  const accountKey = await ensureKey(path.join(acmeDir(), 'account.key'));
  await ensureKey(domainKeyPath);

  const acme = new Acme(accountKey);
  await acme.init();

  // Account (idempotente)
  const acc = await acme.post(acme.dir.newAccount, { termsOfServiceAgreed: true });
  acme.kid = acc.res.headers.get('location');

  // Ordine
  const order = await acme.post(acme.dir.newOrder, { identifiers: [{ type: 'dns', value: domain }] });
  const orderUrl = order.res.headers.get('location');
  const authzUrl = order.body.authorizations[0];

  // Challenge dns-01
  const authz = await acme.post(authzUrl, '');
  const chall = authz.body.challenges.find((c) => c.type === 'dns-01');
  if (!chall) throw new Error('challenge dns-01 non offerta');
  const keyAuth = `${chall.token}.${thumbprint(acme.jwk)}`;
  const txtValue = b64u(crypto.createHash('sha256').update(keyAuth).digest());

  await duckdnsTxt(sub, token, txtValue);
  await sleep(20000); // propagazione TXT
  await acme.post(chall.url, {});

  // Attendi validazione (fino a ~3 min)
  let valid = false;
  for (let i = 0; i < 18; i++) {
    await sleep(10000);
    const a = await acme.post(authzUrl, '');
    if (a.body.status === 'valid') { valid = true; break; }
    if (a.body.status === 'invalid') {
      const err = a.body.challenges?.find((c) => c.error)?.error;
      throw new Error(`validazione fallita: ${err?.detail || 'invalid'}`);
    }
  }
  if (!valid) throw new Error('timeout validazione dns-01');

  // CSR (DER) e finalize
  const csrDer = await new Promise((resolve, reject) => {
    execFile('openssl', ['req', '-new', '-sha256', '-key', domainKeyPath, '-subj', `/CN=${domain}`,
      '-addext', `subjectAltName=DNS:${domain}`, '-outform', 'DER'],
    { timeout: 30000, encoding: 'buffer', maxBuffer: 1 << 20 },
    (e, stdout, stderr) => e ? reject(new Error(String(stderr))) : resolve(stdout));
  });
  await acme.post(order.body.finalize, { csr: b64u(csrDer) });

  // Attendi il certificato
  let certUrl = null;
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    const o = await acme.post(orderUrl, '');
    if (o.body.status === 'valid' && o.body.certificate) { certUrl = o.body.certificate; break; }
    if (o.body.status === 'invalid') throw new Error('ordine invalid dopo finalize');
  }
  if (!certUrl) throw new Error('timeout emissione certificato');

  const certRes = await acme.post(certUrl, '');
  const pem = typeof certRes.body === 'string' ? certRes.body : String(certRes.body);
  if (!pem.includes('BEGIN CERTIFICATE')) throw new Error('risposta certificato non PEM');
  fs.writeFileSync(certPath, pem);

  log.info(`[acme] certificato emesso per ${domain} (valido ${Math.round(certDaysLeft(certPath))} giorni)`);
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(domainKeyPath), renewed: true };
}

// Rinnovo: check giornaliero, sotto i 30 giorni riemette e aggiorna il server
// a caldo (setSecureContext — niente riavvio).
export function scheduleAcmeRenewal(httpsServer) {
  const tick = async () => {
    try {
      const days = certDaysLeft(acmeCertPaths().cert);
      if (days > 30) return;
      const { cert, key } = await ensureAcmeCert();
      httpsServer.setSecureContext({ cert, key });
      log.info('[acme] certificato rinnovato e applicato a caldo');
    } catch (e) {
      log.warn('[acme] rinnovo fallito (ritento domani):', e.message);
    }
  };
  const t = setInterval(tick, 24 * 3600000);
  t.unref();
}
