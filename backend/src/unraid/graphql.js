// Client GraphQL unraid-api (Unraid 7.x): ${UNRAID_URL}/graphql, header x-api-key,
// UNRAID_TLS_INSECURE per cert self-signed. Capability map via introspection:
// le query vengono composte solo con i campi realmente presenti nello schema
// (pools/VM/notifiche variano tra le versioni di unraid-api) → degradazione per-sezione.
import http from 'node:http';
import https from 'node:https';
import { config } from '../core/config.js';
import { log } from '../core/util.js';

let schemaTypes = null;   // mappa nome tipo -> { fields: {name -> {typeName, kind}} }
let caps = null;          // capability map per-feature

function endpoint() {
  if (!config.unraidUrl) return null;
  return config.unraidUrl.replace(/\/$/, '') + '/graphql';
}

// POST JSON con supporto TLS self-signed (SSL forzato ⇒ cert myunraid.net su IP locale).
export function gqlRequest(query, variables = {}, timeoutMs = 15000) {
  const url = endpoint();
  if (!url) return Promise.reject(new Error('UNRAID_URL/UNRAID_HOST non configurati'));
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const body = JSON.stringify({ query, variables });
    const req = (isHttps ? https : http).request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': config.unraidApiKey || '',
        origin: config.unraidUrl,
      },
      rejectUnauthorized: isHttps ? !config.unraidTlsInsecure : undefined,
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`GraphQL HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const json = JSON.parse(data);
          if (json.errors?.length) return reject(new Error(json.errors.map(e => e.message).join('; ')));
          resolve(json.data);
        } catch (e) {
          reject(new Error(`Risposta GraphQL non valida: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout GraphQL')));
    req.on('error', reject);
    req.end(body);
  });
}

// ---- Introspection → capability map ----
const INTROSPECTION = `query {
  __schema {
    queryType { name } mutationType { name } subscriptionType { name }
    types {
      name kind
      fields { name type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } }
    }
  }
}`;

function unwrapType(t) {
  while (t && !t.name && t.ofType) t = t.ofType;
  return t || {};
}

export async function introspect() {
  const data = await gqlRequest(INTROSPECTION, {}, 20000);
  const schema = data.__schema;
  schemaTypes = new Map();
  for (const t of schema.types || []) {
    if (!t.fields) continue;
    const fields = {};
    for (const f of t.fields) {
      const u = unwrapType(f.type);
      fields[f.name] = { typeName: u.name || null, kind: u.kind || null };
    }
    schemaTypes.set(t.name, { fields });
  }
  const qName = schema.queryType?.name || 'Query';
  const mName = schema.mutationType?.name || 'Mutation';
  const sName = schema.subscriptionType?.name;
  const q = schemaTypes.get(qName)?.fields || {};
  const m = schemaTypes.get(mName)?.fields || {};
  const s = sName ? (schemaTypes.get(sName)?.fields || {}) : {};

  caps = {
    array: 'array' in q,
    disks: 'disks' in q,
    pools: 'pools' in q,
    shares: 'shares' in q,
    info: 'info' in q,
    vms: 'vms' in q,
    notifications: 'notifications' in q,
    notificationsSub: 'notificationAdded' in s || 'notificationsOverview' in s,
    arrayMutations: 'array' in m,
    parityMutations: 'parityCheck' in m,
    vmMutations: 'vm' in m,
    reboot: 'reboot' in m,
    shutdown: 'shutdown' in m,
    _queryFields: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v.typeName])),
  };
  log.info('[graphql] capability map:', JSON.stringify(Object.fromEntries(Object.entries(caps).filter(([k]) => !k.startsWith('_')))));
  return caps;
}

export function capabilities() { return caps; }

// Interseca i campi desiderati con quelli presenti nel tipo (schema-adattivo).
export function presentFields(typeName, wanted) {
  const t = schemaTypes?.get(typeName);
  if (!t) return [];
  return wanted.filter(w => (typeof w === 'string' ? w in t.fields : w.name in t.fields));
}
export function fieldType(typeName, fieldName) {
  return schemaTypes?.get(typeName)?.fields?.[fieldName]?.typeName || null;
}

// Costruisce una selezione { campo1 campo2 nested { ... } } dai campi disponibili.
function sel(typeName, spec) {
  const parts = [];
  const t = schemaTypes?.get(typeName);
  if (!t) return '';
  for (const item of spec) {
    if (typeof item === 'string') {
      if (item in t.fields) parts.push(item);
    } else {
      const f = t.fields[item.name];
      if (!f) continue;
      const sub = sel(f.typeName, item.fields);
      if (sub) parts.push(`${item.name} { ${sub} }`);
    }
  }
  return parts.join(' ');
}

// ---- Query per-sezione (composte dinamicamente) ----
const DISK_FIELDS = ['id', 'idx', 'name', 'device', 'size', 'status', 'type', 'temp', 'rotational',
  'numErrors', 'numReads', 'numWrites', 'fsSize', 'fsFree', 'fsUsed', 'fsType', 'exportable', 'color', 'transport'];

export async function queryArray() {
  const arrayType = fieldType('Query', 'array');
  const diskType = fieldType(arrayType, 'disks') || 'ArrayDisk';
  const capType = fieldType(arrayType, 'capacity');
  const spec = [
    'state',
    { name: 'capacity', fields: [{ name: 'kilobytes', fields: ['free', 'used', 'total'] }, { name: 'disks', fields: ['free', 'used', 'total'] }] },
    { name: 'parities', fields: DISK_FIELDS },
    { name: 'disks', fields: DISK_FIELDS },
    { name: 'caches', fields: DISK_FIELDS },
  ];
  // capType può non avere kilobytes → sel() lo scarta da solo
  void capType; void diskType;
  const s = sel(arrayType, spec);
  const data = await gqlRequest(`query { array { ${s} } }`);
  return data.array;
}

export async function queryDisks() {
  const diskType = fieldType('Query', 'disks');
  const s = sel(diskType, ['device', 'name', 'vendor', 'size', 'temperature', 'smartStatus', 'serialNum', 'interfaceType', 'rotational', 'type']);
  const data = await gqlRequest(`query { disks { ${s} } }`);
  return data.disks;
}

export async function queryPools() {
  const poolType = fieldType('Query', 'pools');
  const s = sel(poolType, ['name', 'status', 'state', 'health', 'size', 'used', 'free', 'devices', 'fsType']);
  if (!s) throw new Error('pools non esposto dallo schema');
  const data = await gqlRequest(`query { pools { ${s} } }`);
  return data.pools;
}

export async function queryShares() {
  const shareType = fieldType('Query', 'shares');
  const s = sel(shareType, ['name', 'free', 'used', 'size', 'comment', 'cache', 'exclusive', 'include', 'exclude']);
  const data = await gqlRequest(`query { shares { ${s} } }`);
  return data.shares;
}

export async function queryInfo() {
  const infoType = fieldType('Query', 'info');
  const spec = [
    { name: 'os', fields: ['platform', 'distro', 'release', 'uptime', 'hostname'] },
    { name: 'cpu', fields: ['manufacturer', 'brand', 'cores', 'threads'] },
    { name: 'memory', fields: ['total', 'free', 'used', 'available', 'active'] },
    { name: 'versions', fields: ['unraid', 'kernel', 'docker'] },
  ];
  const s = sel(infoType, spec);
  const data = await gqlRequest(`query { info { ${s} } }`);
  return data.info;
}

export async function queryVms() {
  const vmsType = fieldType('Query', 'vms');
  const domType = fieldType(vmsType, 'domain') || fieldType(vmsType, 'domains');
  const domField = fieldType(vmsType, 'domain') ? 'domain' : (fieldType(vmsType, 'domains') ? 'domains' : null);
  if (!domField) throw new Error('vms.domain non esposto dallo schema');
  const s = sel(domType, ['uuid', 'name', 'state']);
  const data = await gqlRequest(`query { vms { ${domField} { ${s} } } }`);
  return data.vms?.[domField] || [];
}

// ---- Mutations ----
export async function mutateArrayState(desiredState) {
  // desiredState: START | STOP
  const mType = fieldType('Mutation', 'array');
  if (mType && schemaTypes.get(mType)?.fields?.setState) {
    const data = await gqlRequest(
      `mutation ($input: ArrayStateInput!) { array { setState(input: $input) { state } } }`,
      { input: { desiredState } });
    return data.array?.setState;
  }
  throw new Error('mutation array.setState non disponibile');
}

export async function mutateParity(action, correct = false) {
  const mType = fieldType('Mutation', 'parityCheck');
  if (!mType) throw new Error('mutation parityCheck non disponibile');
  const fields = schemaTypes.get(mType)?.fields || {};
  const map = {
    start: fields.start ? `start(correct: ${correct ? 'true' : 'false'})` : null,
    pause: fields.pause ? 'pause' : null,
    resume: fields.resume ? 'resume' : null,
    cancel: fields.cancel ? 'cancel' : null,
  };
  const op = map[action];
  if (!op) throw new Error(`operazione parity "${action}" non disponibile`);
  const data = await gqlRequest(`mutation { parityCheck { ${op} } }`);
  return data.parityCheck;
}

export async function mutateVm(action, id) {
  const mType = fieldType('Mutation', 'vm');
  if (!mType) throw new Error('mutation vm non disponibile');
  const fields = schemaTypes.get(mType)?.fields || {};
  const op = { start: 'start', stop: 'stop', pause: 'pause', resume: 'resume', reboot: 'reboot', forceStop: 'forceStop' }[action];
  if (!op || !fields[op]) throw new Error(`operazione VM "${action}" non disponibile`);
  const data = await gqlRequest(`mutation ($id: PrefixedID!) { vm { ${op}(id: $id) } }`, { id });
  return data.vm;
}

export async function mutatePower(action) {
  // action: reboot | shutdown
  if (!caps?.[action]) throw new Error(`mutation ${action} non esposta dallo schema`);
  const data = await gqlRequest(`mutation { ${action} }`);
  return data[action];
}
