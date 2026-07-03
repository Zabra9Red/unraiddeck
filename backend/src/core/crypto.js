// Cifratura segreti at-rest (AES-256-GCM) con chiave autogenerata in /config.
// NB: protegge da letture accidentali del DB, non da chi ha pieno accesso a /config.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let key = null;

export function initCrypto() {
  const keyPath = path.join(config.configDir, 'secret.key');
  if (fs.existsSync(keyPath)) {
    key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
    if (key.length !== 32) throw new Error('secret.key corrotta (attesi 32 byte hex)');
  } else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600 });
  }
}

// Ritorna base64(iv | tag | ciphertext).
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(b64) {
  const raw = Buffer.from(b64, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Token di sessione: 256 bit random; in DB si salva solo l'hash SHA-256.
export function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
export function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
