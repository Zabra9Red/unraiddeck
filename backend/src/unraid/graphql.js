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

// POST JSON con supporto TLS self-signed (SSL forzato ⇒ cert myunraid.net su IP
// locale) e follow dei redirect: con "Use SSL: Yes" il server risponde 302 verso
// https://<hash>.myunraid.net — va seguito, il cert lì è valido.
function postJson(urlStr, body, timeoutMs, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? https : http).request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': config.unraidApiKey || '',
        origin: `${u.protocol}//${u.host}`,
      },
      rejectUnauthorized: isHttps ? !config.unraidTlsInsecure : undefined,
      timeout: timeoutMs,
    }, (res) => {
      // Redirect (SSL forzato): ripeti la POST sulla nuova location
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Troppi redirect dal GraphQL (SSL forzato?)'));
        const next = new URL(res.headers.location, urlStr);
        next.pathname = '/graphql'; // il redirect può puntare alla root
        return resolve(postJson(next.href, body, timeoutMs, redirectsLeft - 1));
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        // Apollo risponde anche 400 con body JSON {errors:[...]}: gli errori
        // GraphQL vanno estratti a prescindere dallo status HTTP.
        let json = null;
        try { json = JSON.parse(data); } catch { /* non-JSON, gestito sotto */ }
        if (json?.errors?.length) return reject(new Error(json.errors.map(e => e.message).join('; ')));
        if (res.statusCode < 200 || res.statusCode >= 300 || !json) {
          return reject(new Error(`GraphQL HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        resolve(json.data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout GraphQL')));
    req.on('error', (e) => {
      // Suggerimento chiaro per il caso cert self-signed su IP
      if (/certificate|self[- ]signed|unable to verify/i.test(e.message)) {
        return reject(new Error(`${e.message} — impostare UNRAID_TLS_INSECURE=true oppure UNRAID_URL con l'hostname del certificato`));
      }
      reject(e);
    });
    req.end(body);
  });
}

export function gqlRequest(query, variables = {}, timeoutMs = 15000) {
  const url = endpoint();
  if (!url) return Promise.reject(new Error('UNRAID_URL/UNRAID_HOST non configurati'));
  return postJson(url, JSON.stringify({ query, variables }), timeoutMs, 3);
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

// Schema statico di riserva (unraid-api 7.x) per server con introspection
// disabilitata (default Apollo in produzione). I nomi campo errati per la
// versione in uso vengono eliminati a runtime da pruneRejectedFields().
const STATIC_TYPES = {
  Query: { array: 'UnraidArray', disks: 'Disk', shares: 'Share', info: 'Info', vms: 'Vms', vars: 'Vars', metrics: 'Metrics', parityHistory: 'ParityCheck', notifications: 'Notifications' },
  Mutation: { array: 'ArrayMutations', parityCheck: 'ParityCheckMutations', vm: 'VmMutations', reboot: 'Boolean', shutdown: 'Boolean' },
  UnraidArray: { state: 'String', capacity: 'ArrayCapacity', parities: 'ArrayDisk', disks: 'ArrayDisk', caches: 'ArrayDisk' },
  ArrayCapacity: { kilobytes: 'Capacity', disks: 'Capacity' },
  Capacity: { free: 'String', used: 'String', total: 'String' },
  ArrayDisk: Object.fromEntries(['id', 'idx', 'name', 'device', 'size', 'status', 'type', 'temp', 'rotational', 'numErrors', 'numReads', 'numWrites', 'fsSize', 'fsFree', 'fsUsed', 'fsType', 'exportable', 'color', 'transport'].map(f => [f, 'String'])),
  Disk: { id: 'String', device: 'String', name: 'String', vendor: 'String', size: 'String', temperature: 'Int', smartStatus: 'String', serialNum: 'String', interfaceType: 'String', rotational: 'Boolean', type: 'String' },
  Share: { name: 'String', free: 'String', used: 'String', size: 'String', comment: 'String', cache: 'Boolean', include: 'String', exclude: 'String' },
  Info: { os: 'InfoOs', cpu: 'InfoCpu', memory: 'InfoMemory', versions: 'InfoVersions' },
  InfoOs: { platform: 'String', distro: 'String', release: 'String', uptime: 'String', hostname: 'String' },
  InfoCpu: { manufacturer: 'String', brand: 'String', cores: 'Int', threads: 'Int' },
  InfoVersions: { unraid: 'String', kernel: 'String', docker: 'String' },
  Vms: { domain: 'VmDomain', domains: 'VmDomain' },
  VmDomain: { uuid: 'String', name: 'String', state: 'String' },
  ArrayMutations: { setState: 'UnraidArray' },
  ParityCheckMutations: { start: 'Boolean', pause: 'Boolean', resume: 'Boolean', cancel: 'Boolean' },
  VmMutations: { start: 'Boolean', stop: 'Boolean', pause: 'Boolean', resume: 'Boolean', reboot: 'Boolean', forceStop: 'Boolean' },
};

function loadStaticSchema() {
  schemaTypes = new Map();
  for (const [name, fields] of Object.entries(STATIC_TYPES)) {
    schemaTypes.set(name, {
      fields: Object.fromEntries(Object.entries(fields).map(([f, tn]) => [f, { typeName: tn, kind: 'OBJECT' }])),
    });
  }
  const q = schemaTypes.get('Query').fields;
  const m = schemaTypes.get('Mutation').fields;
  caps = {
    array: true, disks: true, pools: false, shares: true, info: true, vms: true,
    notifications: 'notifications' in q,
    notificationsSub: false, // senza introspection non assumiamo la subscription
    arrayMutations: 'array' in m, parityMutations: 'parityCheck' in m, vmMutations: 'vm' in m,
    reboot: true, shutdown: true,
    _static: true,
    _queryFields: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v.typeName])),
  };
  return caps;
}

// "Cannot query field \"x\" on type \"Y\"" → elimina il campo dallo schema
// locale così il prossimo tentativo compone la query senza. Serve col fallback
// statico, dove i campi sono ipotizzati e non letti dal server.
function pruneRejectedFields(message) {
  let pruned = false;
  for (const m of String(message).matchAll(/Cannot query field "([^"]+)" on type "([^"]+)"/g)) {
    const [, field, typeName] = m;
    const t = schemaTypes?.get(typeName);
    if (t && field in t.fields) { delete t.fields[field]; pruned = true; continue; }
    // Il server può chiamare il tipo diversamente dallo schema statico
    // (es. "InfoVersions" vs "Versions"): prova il match per somiglianza di
    // nome, poi come ultima risorsa elimina il campo da qualunque tipo lo abbia.
    let matched = false;
    for (const [name, tt] of schemaTypes || []) {
      if ((typeName.includes(name) || name.includes(typeName)) && field in tt.fields) {
        delete tt.fields[field];
        pruned = true; matched = true;
      }
    }
    if (matched) continue;
    for (const [, tt] of schemaTypes || []) {
      if (field in tt.fields) { delete tt.fields[field]; pruned = true; }
    }
  }
  return pruned;
}

// Esegue build() (che compone la query dallo schema corrente); se il server
// rifiuta dei campi li elimina e riprova, finché la query passa.
async function gqlAdaptive(build) {
  for (let i = 0; i < 4; i++) {
    try { return await build(); }
    catch (e) { if (!pruneRejectedFields(e.message)) throw e; }
  }
  return build();
}

export async function introspect() {
  let data;
  try {
    data = await gqlRequest(INTROSPECTION, {}, 20000);
  } catch (e) {
    if (/introspection/i.test(String(e.message))) {
      log.warn('[graphql] introspection disabilitata dal server: uso lo schema statico unraid-api 7.x (campi non supportati eliminati al primo errore)');
      return loadStaticSchema();
    }
    throw e;
  }
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

export function queryArray() {
  return gqlAdaptive(async () => {
    const arrayType = fieldType('Query', 'array');
    const spec = [
      'state',
      { name: 'capacity', fields: [{ name: 'kilobytes', fields: ['free', 'used', 'total'] }, { name: 'disks', fields: ['free', 'used', 'total'] }] },
      { name: 'parities', fields: DISK_FIELDS },
      { name: 'disks', fields: DISK_FIELDS },
      { name: 'caches', fields: DISK_FIELDS },
    ];
    const s = sel(arrayType, spec);
    const data = await gqlRequest(`query { array { ${s} } }`);
    return data.array;
  });
}

export function queryDisks() {
  return gqlAdaptive(async () => {
    const diskType = fieldType('Query', 'disks');
    const s = sel(diskType, ['device', 'name', 'vendor', 'size', 'temperature', 'smartStatus', 'serialNum', 'interfaceType', 'rotational', 'type']);
    const data = await gqlRequest(`query { disks { ${s} } }`);
    return data.disks;
  });
}

export function queryPools() {
  return gqlAdaptive(async () => {
    const poolType = fieldType('Query', 'pools');
    const s = sel(poolType, ['name', 'status', 'state', 'health', 'size', 'used', 'free', 'devices', 'fsType']);
    if (!s) throw new Error('pools non esposto dallo schema');
    const data = await gqlRequest(`query { pools { ${s} } }`);
    return data.pools;
  });
}

export function queryShares() {
  return gqlAdaptive(async () => {
    const shareType = fieldType('Query', 'shares');
    const s = sel(shareType, ['name', 'free', 'used', 'size', 'comment', 'cache', 'exclusive', 'include', 'exclude']);
    const data = await gqlRequest(`query { shares { ${s} } }`);
    return data.shares;
  });
}

export function queryInfo() {
  return gqlAdaptive(async () => {
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
  });
}

export function queryVms() {
  return gqlAdaptive(async () => {
    const vmsType = fieldType('Query', 'vms');
    const domType = fieldType(vmsType, 'domain') || fieldType(vmsType, 'domains');
    const domField = fieldType(vmsType, 'domain') ? 'domain' : (fieldType(vmsType, 'domains') ? 'domains' : null);
    if (!domField) throw new Error('vms.domain non esposto dallo schema');
    const s = sel(domType, ['uuid', 'name', 'state']);
    const data = await gqlRequest(`query { vms { ${domField} { ${s} } } }`);
    return data.vms?.[domField] || [];
  });
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
