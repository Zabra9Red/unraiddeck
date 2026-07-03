// TOTP RFC 6238 (SHA-1, 6 cifre, periodo 30s) — implementazione nativa, zero dipendenze.
import crypto from 'node:crypto';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160 bit
}

function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

// Verifica con finestra ±1 step (tolleranza clock skew).
export function verifyTotp(secretB32, code, window = 1) {
  const secret = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 1000 / 30);
  const clean = String(code).replace(/\s/g, '');
  for (let i = -window; i <= window; i++) {
    if (hotp(secret, step + i) === clean) return true;
  }
  return false;
}

export function totpUri(secretB32, username, issuer = 'UnraidDeck') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// Codici di recupero monouso: 10 codici da 10 caratteri (salvati hashati).
export function generateRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () =>
    crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{5}/g).join('-'));
}
