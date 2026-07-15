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
  onlyofficeUrl: env.ONLYOFFICE_URL ? env.ONLYOFFICE_URL.replace(/\/+$/, '') : null,
  onlyofficeJwtSecret: env.ONLYOFFICE_JWT_SECRET || null,
  onlyofficeSelfUrl: env.ONLYOFFICE_SELF_URL ? env.ONLYOFFICE_SELF_URL.replace(/\/+$/, '') : null,

  // File manager locale (bind mount /mnt → /unraid) — spec Viewer&Editor v1.2
  fmRoots: env.FM_ROOTS || '/unraid',
  fmEditEnabled: bool(env.FM_EDIT_ENABLED, true),
  fmKeepVersions: Math.max(0, parseInt(env.FM_KEEP_VERSIONS || '3', 10) || 0),
  fmOrigBackup: bool(env.FM_ORIG_BACKUP, true),
  officeEditor: (env.OFFICE_EDITOR || 'auto').toLowerCase(), // auto | off (auto: attivo se coolwsd presente)

  // HTTPS nativo: TLS sulla porta principale; cert self-signed autogenerato
  // in /config/certs se assente (override path con HTTPS_CERT/HTTPS_KEY)
  httpsEnabled: bool(env.HTTPS, false),
  httpsCert: env.HTTPS_CERT || null,
  httpsKey: env.HTTPS_KEY || null,
  notifyWebhookType: (env.NOTIFY_WEBHOOK_TYPE || '').toLowerCase() || null, // 'ntfy' | 'json' | null = auto dal hostname

  // Intervalli polling fallback SSH (spec §5), override via env
  pollSystem: parseDuration(env.POLL_SYSTEM, 5000),
  pollArray: parseDuration(env.POLL_ARRAY, 30000),
  pollDisks: parseDuration(env.POLL_DISKS, 60000),
  pollShares: parseDuration(env.POLL_SHARES, 300000),
  pollUps: parseDuration(env.POLL_UPS, 10000),

  tz: env.TZ || 'Europe/Rome',
  version: env.UNRAIDDECK_VERSION || '1.19.0',
};

export default config;
