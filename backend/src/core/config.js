// Configurazione centralizzata da variabili d'ambiente.
import path from 'node:path';

// Converte durate tipo "6h", "30m", "45s", "1500" (ms) in millisecondi.
export function parseDuration(str, fallbackMs) {
  if (str === undefined || str === null || str === '') return fallbackMs;
  const m = String(str).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) return fallbackMs;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  const mul = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return Math.round(n * mul);
}

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const env = process.env;

export const config = {
  port: parseInt(env.PORT || '8787', 10),
  configDir: path.resolve(env.CONFIG_DIR || '/config'),
  bootstrapPassword: env.PASSWORD || null,

  unraidHost: env.UNRAID_HOST || null,
  unraidUrl: env.UNRAID_URL || (env.UNRAID_HOST ? `http://${env.UNRAID_HOST}` : null),
  unraidTlsInsecure: bool(env.UNRAID_TLS_INSECURE, false),
  unraidApiKey: env.UNRAID_API_KEY || null,

  sshUser: env.SSH_USER || null,
  sshPassword: env.SSH_PASSWORD || null,
  sshKey: env.SSH_KEY || null, // percorso file oppure chiave PEM inline

  dockerHost: env.DOCKER_HOST || null, // opzionale (es. socket-proxy tcp://)

  disableAuth: bool(env.DISABLE_AUTH, false),
  trustProxy: env.TRUST_PROXY || null, // es. "true", "1", "loopback", IP

  updateCheckInterval: parseDuration(env.UPDATE_CHECK_INTERVAL, 6 * 3600000),
  updateVerifyTimeout: env.UPDATE_VERIFY_TIMEOUT ? parseDuration(env.UPDATE_VERIFY_TIMEOUT, null) : null, // null = auto

  notifyWebhookUrl: env.NOTIFY_WEBHOOK_URL || null,

  // Intervalli polling fallback SSH (spec §5), override via env
  pollSystem: parseDuration(env.POLL_SYSTEM, 5000),
  pollArray: parseDuration(env.POLL_ARRAY, 30000),
  pollDisks: parseDuration(env.POLL_DISKS, 60000),
  pollShares: parseDuration(env.POLL_SHARES, 300000),

  tz: env.TZ || 'Europe/Rome',
  version: env.UNRAIDDECK_VERSION || '1.4.2',
};

export default config;
