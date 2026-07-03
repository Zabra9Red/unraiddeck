// Autenticazione: setup wizard, sessioni opache in SQLite (token random 256 bit,
// cookie httpOnly SameSite=Strict, Secure automatico dietro proxy HTTPS),
// scadenza 24h scorrevole, revoca reale, TOTP opzionale, rate limit login con backoff.
import bcrypt from 'bcryptjs';
import { db } from './db.js';
import { config } from './config.js';
import { encrypt, decrypt, randomToken, hashToken, sha256hex } from './crypto.js';
import { verifyTotp, generateTotpSecret, generateRecoveryCodes, totpUri } from './totp.js';
import { audit } from './audit.js';
import { log } from './util.js';

const SESSION_TTL = 24 * 3600000; // 24h scorrevoli
const COOKIE_NAME = 'unraiddeck_session';

// ---- Stato utenti ----
export function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}
export function setupRequired() {
  return userCount() === 0 && !config.disableAuth;
}

export function createUser(username, password) {
  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, hash, Date.now());
  return info.lastInsertRowid;
}

// Bootstrap: se non esistono utenti e PASSWORD è settata, crea "admin" con quella password.
export function bootstrapFromEnv() {
  if (userCount() === 0 && config.bootstrapPassword) {
    createUser('admin', config.bootstrapPassword);
    log.warn('[auth] Utente "admin" creato dalla env PASSWORD (bootstrap). Rimuovere PASSWORD dal template dopo il primo avvio.');
    audit(null, 'auth.bootstrap', 'admin', 'ok', null, 'utente creato da env PASSWORD');
  }
}

// Warning UI: PASSWORD env ancora settata dopo il setup.
export function passwordEnvWarning() {
  return Boolean(config.bootstrapPassword) && userCount() > 0;
}

// ---- Rate limit login: 5 tentativi / 15 min per IP, con backoff ----
const loginAttempts = new Map(); // ip -> { fails: [ts...], lockedUntil }
export function loginRateCheck(ip) {
  const now = Date.now();
  const st = loginAttempts.get(ip);
  if (!st) return { ok: true };
  if (st.lockedUntil && now < st.lockedUntil) {
    return { ok: false, retryAfter: Math.ceil((st.lockedUntil - now) / 1000) };
  }
  st.fails = st.fails.filter(t => now - t < 15 * 60000);
  if (st.fails.length >= 5) {
    // Backoff: raddoppia a ogni superamento (1 min, 2, 4... cap 30 min)
    st.lockCount = (st.lockCount || 0) + 1;
    st.lockedUntil = now + Math.min(30 * 60000, 60000 * 2 ** (st.lockCount - 1));
    st.fails = [];
    return { ok: false, retryAfter: Math.ceil((st.lockedUntil - now) / 1000) };
  }
  return { ok: true };
}
export function loginRateFail(ip) {
  const st = loginAttempts.get(ip) || { fails: [] };
  st.fails.push(Date.now());
  loginAttempts.set(ip, st);
}
export function loginRateReset(ip) {
  loginAttempts.delete(ip);
}

// ---- Login ----
// Ritorna { ok, token } | { ok:false, reason:'credentials'|'totp_required'|'totp_invalid' }
export function login(username, password, totpCode, req) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return { ok: false, reason: 'credentials' };
  }
  if (user.totp_enabled) {
    if (!totpCode) return { ok: false, reason: 'totp_required' };
    if (!checkTotpOrRecovery(user, totpCode)) return { ok: false, reason: 'totp_invalid' };
  }
  const token = createSession(user, req);
  return { ok: true, token, user: { id: user.id, username: user.username } };
}

function checkTotpOrRecovery(user, code) {
  const secret = decrypt(user.totp_secret_enc);
  if (verifyTotp(secret, code)) return true;
  // Prova come recovery code monouso (salvati hashati)
  const codes = user.recovery_codes ? JSON.parse(user.recovery_codes) : [];
  const h = sha256hex(String(code).toUpperCase().replace(/\s/g, ''));
  const idx = codes.indexOf(h);
  if (idx >= 0) {
    codes.splice(idx, 1);
    db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(codes), user.id);
    return true;
  }
  return false;
}

export function createSession(user, req) {
  const token = randomToken();
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at, ip, user_agent)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(hashToken(token), user.id, now, now, now + SESSION_TTL,
      req?.ip || null, (req?.headers?.['user-agent'] || '').slice(0, 200));
  return token;
}

export function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}
export function destroyAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
export function listSessions(userId, currentToken) {
  const cur = currentToken ? hashToken(currentToken) : null;
  return db.prepare('SELECT token_hash, created_at, last_seen, expires_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen DESC')
    .all(userId)
    .map(s => ({
      id: s.token_hash.slice(0, 12), createdAt: s.created_at, lastSeen: s.last_seen,
      expiresAt: s.expires_at, ip: s.ip, userAgent: s.user_agent, current: s.token_hash === cur,
    }));
}
export function destroySessionByPrefix(userId, prefix) {
  const rows = db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').all(userId);
  const hit = rows.find(r => r.token_hash.startsWith(prefix));
  if (hit) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hit.token_hash);
  return Boolean(hit);
}

// Valida un token e applica la scadenza scorrevole. Ritorna user o null.
export function validateSession(token) {
  if (!token) return null;
  const now = Date.now();
  const row = db.prepare(`SELECT s.token_hash, s.expires_at, s.last_seen, u.id, u.username, u.totp_enabled
                          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`)
    .get(hashToken(token));
  if (!row) return null;
  if (row.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  // Rinnovo scorrevole: aggiorna al massimo una volta al minuto (riduce scritture)
  if (now - row.last_seen > 60000) {
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?')
      .run(now, now + SESSION_TTL, row.token_hash);
  }
  return { id: row.id, username: row.username, totpEnabled: Boolean(row.totp_enabled) };
}

export function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

// ---- Cookie helpers ----
export function setSessionCookie(req, res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: Boolean(req.secure), // automatico dietro reverse proxy HTTPS (richiede trust proxy)
    maxAge: SESSION_TTL,
    path: '/',
  });
}
export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}
export function tokenFromReq(req) {
  return req.cookies?.[COOKIE_NAME] || null;
}

// ---- Middleware Express ----
export function requireAuth(req, res, next) {
  if (config.disableAuth) {
    req.user = { id: 0, username: 'anonimo' };
    return next();
  }
  const user = validateSession(tokenFromReq(req));
  if (!user) return res.status(401).json({ error: 'Non autenticato' });
  req.user = user;
  next();
}

// Difesa in profondità anti-CSRF sulle route mutanti: verifica Origin / Sec-Fetch-Site
// (oltre a SameSite=Strict sul cookie).
export function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && !['same-origin', 'same-site', 'none'].includes(sfs)) {
    return res.status(403).json({ error: 'Richiesta cross-site rifiutata' });
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      const oHost = new URL(origin).host;
      if (oHost !== req.headers.host) {
        return res.status(403).json({ error: 'Origin non valida' });
      }
    } catch {
      return res.status(403).json({ error: 'Origin malformata' });
    }
  }
  next();
}

// Stessa verifica per l'handshake socket.io (anti cross-site WebSocket hijacking).
export function socketOriginOk(handshake) {
  const origin = handshake.headers.origin;
  if (!origin) return true; // client non-browser
  try {
    return new URL(origin).host === handshake.headers.host;
  } catch {
    return false;
  }
}
export function socketAuth(handshake) {
  if (config.disableAuth) return { id: 0, username: 'anonimo' };
  const cookies = Object.fromEntries((handshake.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('=');
    return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
  return validateSession(cookies[COOKIE_NAME]);
}

// ---- TOTP management ----
export function totpSetup(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const secret = generateTotpSecret();
  // Salva il secret cifrato ma non ancora abilitato (conferma con un codice valido)
  db.prepare('UPDATE users SET totp_secret_enc = ?, totp_enabled = 0 WHERE id = ?').run(encrypt(secret), userId);
  return { secret, uri: totpUri(secret, user.username) };
}
export function totpEnable(userId, code) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user.totp_secret_enc) return { ok: false, reason: 'setup mancante' };
  if (!verifyTotp(decrypt(user.totp_secret_enc), code)) return { ok: false, reason: 'codice non valido' };
  const codes = generateRecoveryCodes();
  db.prepare('UPDATE users SET totp_enabled = 1, recovery_codes = ? WHERE id = ?')
    .run(JSON.stringify(codes.map(c => sha256hex(c))), userId);
  return { ok: true, recoveryCodes: codes };
}
export function totpDisable(userId, code) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user.totp_enabled) return { ok: true };
  if (!checkTotpOrRecovery(user, code)) return { ok: false, reason: 'codice non valido' };
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, recovery_codes = NULL WHERE id = ?').run(userId);
  return { ok: true };
}

export function changePassword(userId, oldPassword, newPassword) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!bcrypt.compareSync(oldPassword, user.password_hash)) return { ok: false, reason: 'password attuale errata' };
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 12), userId);
  return { ok: true };
}
