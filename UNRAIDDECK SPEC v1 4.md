# UnraidDeck — Build Spec v1.4

> Dashboard all-in-one per Unraid + Docker. **Un solo container, zero dipendenze esterne.**
> v1.4 — guard SQLite su FUSE/shfs, update a cascata dei dipendenti `net=container:` (VPN), verifica update healthcheck-aware, self escluso dal bulk, negoziazione versione API Docker, hardening icon-proxy (anti-SSRF), capability map GraphQL via introspection, `UNRAID_URL` + TLS self-signed, badge immagini locali, timeout/backoff sui check registry, power host, exec in audit, TOTP opzionale, `DOCKER_HOST` opzionale, `system df` on-demand.

## 1. Obiettivo

Un singolo container Docker con web UI per:
1. Gestione completa dei container Docker dell'host Unraid
2. Monitoraggio/controllo del sistema Unraid (array, dischi, pool, risorse, VM, UPS)

## 2. Stack

| Layer | Scelta | Note |
|---|---|---|
| Backend | Node.js **22 LTS** + Express + dockerode + socket.io | Node 20 EOL 04/2026 |
| Frontend | React **19** + Vite + Tailwind **v4** | Catppuccin Mocha, responsive, **PWA** (install richiede HTTPS → reverse proxy; su http resta usabile, solo senza install). React 18 solo se una lib non fosse pronta |
| Docker | `/var/run/docker.sock` (rw) via dockerode; `DOCKER_HOST` opzionale (es. socket-proxy tcp) | solo API/streams, mai CLI `docker`; **versione API negoziata all'avvio** (`GET /version`, loggata) |
| Unraid 7.x | GraphQL `unraid-api` → `${UNRAID_URL}/graphql` (default `http://UNRAID_HOST`), header `x-api-key`; `UNRAID_TLS_INSECURE` per cert self-signed (SSL forzato ⇒ redirect https con cert myunraid.net su IP locale) | primario; **capability map via introspection** |
| Unraid 6.12 | SSH (lib `ssh2`) + parsing `/var/local/emhttp/*.ini` | fallback |
| DB | better-sqlite3 in `/config` — **`journal_mode=WAL` + `busy_timeout`**, checkpoint periodico **e su shutdown**; backup giornaliero **`VACUUM INTO /config/backups`** (retention 7) | build deps musl nello stage build. **Guard FUSE**: se `/config` sta su `fuse.shfs` (`/mnt/user`) ⇒ warning all'avvio + banner UI — WAL su FUSE rischia corruzione: usare path diretto (`/mnt/cache/...`) o share *exclusive* |
| Immagine | `node:22-alpine` multi-stage, **amd64** (Unraid è solo x86_64) | porta 8787 |

## 3. Architettura backend

```
src/
  docker/   manager.js  stats-hub.js  events.js  updates.js  logs.js  exec.js
  unraid/   graphql.js  ssh-fallback.js  poller.js
  core/     auth.js  audit.js  notify.js  db.js  crypto.js  config.js
  api/      routes REST + namespaces socket.io
```

Principi:
- Il server è l'**unica** sorgente di streaming: 1 sorgente Docker per risorsa → broadcast socket.io a N client (rooms: `events`, `stats`, `logs:<id>`, `unraid`).
- `docker /events` pilota gli aggiornamenti di stato: **niente polling della lista a regime**. Lo stream può cadere (anche per restart di dockerd) → auto-reconnect con exponential backoff, replay con `since=<timeNano ultimo evento>` (**dedupe su `id+action+timeNano`**) e **una** list di riconciliazione a ogni riconnessione.
- All'avvio: negoziazione versione API Docker e **introspection GraphQL** → capability map per-feature (pools/VM/notifiche variano tra le versioni di `unraid-api`): degradazione **per-sezione**, non per-tab.
- Feature flag runtime: API Unraid giù ⇒ tab Unraid disabilitata con motivo visibile; la parte Docker resta pienamente operativa.

## 4. Funzionalità Docker

### 4.1 Lista container
Nome, immagine+tag, stato, uptime, CPU%, RAM, I/O rete, porte, restart policy.
- Icona: label `net.unraid.docker.icon`, **proxata e cacheata dal server in `/config`** (funziona offline, niente mixed-content dietro HTTPS), con guard-rail anti-SSRF/abuso: solo http/https, timeout 5 s, ≤1 MB, ≤3 redirect, content-type `image/*`; servita con content-type fisso + `X-Content-Type-Options: nosniff`; cache LRU con cap 50 MB. Fallback: iniziali colorate.
- Pulsante **Apri WebUI**: label `net.unraid.docker.webui` (risolvere `[IP]` / `[PORT:x]`).

### 4.2 Azioni
`start / stop / restart / pause-unpause / kill / remove / update / prune immagini dangling`

**Lock per-container**: una sola operazione mutante per id alla volta (bulk incluso); richieste concorrenti → **409** con messaggio chiaro.

Procedura **update** (pull + recreate):
1. Pull nuova immagine (progresso via ws). Se il digest coincide con l'immagine in uso → **"già aggiornato"**, nessun recreate.
2. `inspect` completo e **clone integrale** di `Config` + `HostConfig` (nessuna whitelist di campi: passano automaticamente anche Healthcheck, StopSignal/StopTimeout, Ulimits, Tmpfs, DNS, limiti CPU/RAM, ecc.); si sostituisce solo `Image`. **Azzerare `Config.Hostname` se coincide con lo short-id del vecchio container** (è il default generato, non un hostname scelto: non va congelato nel clone).
3. Reti: `ContainerCreate` accetta **una sola rete** in `NetworkingConfig` → create con la prima, poi `network connect` per tutte le altre **prima dello start**, preservando `IPv4Address`, `MacAddress` e aliases (su Unraid br0/macvlan/ipvlan gli IP statici sono la norma). Con API ≥1.44 il create accetta più endpoint: usarlo se disponibile, loop `connect` come percorso universale.
4. Stop → rename in `<nome>-old-<unixts>` (suffisso **univoco**) → create con **lo stesso nome** (l'autostart di dockerman è per nome) → start → **verifica healthcheck-aware**: se il container definisce Healthcheck, attesa `healthy` entro `start_period`+30 s (cap 120 s); altrimenti running stabile 10 s (`UPDATE_VERIFY_TIMEOUT` per override) → remove old. **Rollback automatico** se start/verifica falliscono. **Journal di update in SQLite** (aperto prima del rename, chiuso a fine procedura): all'avvio gli update interrotti da crash/riavvio vengono completati o rollbackati e i residui `-old-*` orfani rimossi.
5. **Dipendenti `NetworkMode=container:<target>`** (pattern VPN, comunissimo su Unraid): rilevati **prima** dell'update e mostrati nella conferma; dopo update riuscito, **ricreati** con la stessa procedura di clone (il netns deve puntare al nuovo id) o riavviati se riferiti per nome; inclusi nel journal.
6. Post-verifica ok: rimozione dell'immagine precedente rimasta dangling (opzione, default on).
7. **Self-update**: il container non può ricrearsi da solo → spawn di un helper effimero detached (stessa immagine, `CMD updater <selfId>`, mount di `/var/run/docker.sock` e `/config`, `AutoRemove`, label `net.unraiddeck.helper=1`) che esegue i passi 1–6 e termina. **UnraidDeck è sempre escluso dal bulk** (si aggiorna solo via helper). Helper esclusi dalla lista UI; **GC all'avvio** di eventuali helper zombie.
8. Protezione self: stop/remove di UnraidDeck stesso richiedono conferma rafforzata.

### 4.3 Check aggiornamenti
- Registry HTTP API v2: `HEAD /v2/<repo>/manifests/<tag>` con `Accept: application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json` (anche i tipi single-manifest: i repo single-arch altrimenti rischiano fallback schema1 → digest sbagliato) → digest remoto vs `RepoDigests` locale (le HEAD non contano nei rate limit Docker Hub).
- Timeout 10 s per HEAD, concorrenza `p-limit(4)`, backoff per-registry su 429.
- Token anonimo per-registry (Docker Hub, ghcr.io, lscr.io, quay.io); **credenziali opzionali per-registry** (cifrate at-rest come gli altri segreti) per repo privati, usate per check **e** pull; risultati in cache SQLite.
- Container avviati per digest (`repo@sha256:…`): nessun tag da confrontare → badge **"pinned"**, check saltato con motivo visibile.
- Immagini senza `RepoDigests`/`RepoTags` (build o import locali): badge **"locale"**, check e update non applicabili, motivo visibile.
- Intervallo `UPDATE_CHECK_INTERVAL` (default **6h**, con jitter) + check manuale per-container e globale. Badge "update available".

### 4.4 Stats real-time
- **Niente stream persistenti per-container** (1 push/s ciascuno da dockerd: non scala): batch `GET /containers/{id}/stats?stream=false&one-shot=true` (API ≥1.41; sotto — negoziata all'avvio — fallback `stream=false` a campione singolo) con `p-limit(8)`, attivo solo se ≥1 client è nella room.
- `one-shot` non include `precpu` → delta CPU calcolato dal campione precedente tenuto in RAM per container.
- Intervallo adattivo: **2 s** con drawer aperto, **5 s** con sola lista visibile.
- Ring buffer 120 punti **in RAM** (niente scritture SQLite per-secondo); broadcast coalescato ogni ciclo.
- `CPU% = (cpu_delta / system_delta) * online_cpus * 100`; RAM = `usage − inactive_file` (**cgroup v2**, default da Unraid 6.12) oppure `usage − total_inactive_file` (cgroup v1) — rilevare i campi presenti, **mai** assumere `cache`.
- Sparkline per riga + grafico esteso nel drawer del container.

### 4.5 Logs
- `logs --follow` con **demux stdout/stderr** (stream multiplexed Docker), `tail` default 500.
- **Coalescing lato server**: righe accumulate e flush ≤100 ms per messaggio ws (i container verbosi non saturano il socket).
- Ricerca/highlight client-side, pausa autoscroll, download **in streaming** (mai bufferizzare tutto in RAM).

### 4.6 Console exec
- xterm.js con resize TTY, cleanup sessioni su disconnect ws, timeout inattività 15 min, max 3 sessioni per utente.

### 4.7 Bulk
- start/stop/restart/update su selezione multipla; concorrenza `p-limit(3)` (rispettando il lock per-container); report esiti per-container. UnraidDeck stesso mai incluso (vedi 4.2).

### 4.8 Spazio disco
- `GET /system/df` **solo on-demand** (endpoint lento su host grandi, mai in polling): overview spazio immagini / volumi / build cache. Prune dangling già coperto in 4.2.

## 5. Funzionalità Unraid

| Dato | 7.x (GraphQL) | 6.12 (fallback SSH) |
|---|---|---|
| Array / parity | query + mutation `array` | `var.ini`; `mdcmd` solo per start/stop/check |
| Dischi | query `disks` | `disks.ini` (temp, spin, errori, fs) |
| **Pool cache (ZFS/BTRFS)** | query `pools` se esposta dallo schema, altrimenti SSH | `zpool status -x`, `btrfs dev stats` (salute + scrub) |
| Shares | query `shares` | `shares.ini` + `df` |
| Sistema | query `info` / metrics | `/proc/stat`, `/proc/meminfo`, `sensors`, `uptime` |
| **Power host** | mutation `reboot` / `shutdown` se esposte dallo schema | `powerdown -r` / `powerdown` via SSH |
| VM | query/mutation `vms` | `virsh` via SSH; opz. mount `/var/run/libvirt/libvirt-sock` |
| Notifiche | subscription se disponibile | — |

Regole critiche:
- **Mai smartctl periodico**: temperatura e spin state SEMPRE da `disks.ini` (non sveglia i dischi in spin-down). SMART completo solo on-demand con `smartctl -n standby -a /dev/sdX`.
- Parity: start/pausa/riprendi/annulla + % progresso; **storico da `/boot/config/parity-checks.log`**.
- UPS: apcupsd NIS `tcp/3551` (protocollo apcaccess) oppure NUT `tcp/3493` (`upsc`) verso `UNRAID_HOST` — **nessun mount necessario**.
- Polling fallback SSH (configurabili): sistema 5 s · array 30 s · dischi 60 s · shares/pool 300 s. Connessione SSH persistente con keep-alive e riconnessione con exponential backoff.

## 6. Notifiche

- In-app (campanella + toast), persistite in SQLite: disco oltre soglia temp (default 45 °C), errore parity, pool degraded, container `exited != 0`, update disponibili, UPS on-battery.
- **Isteresi + cooldown**: rientro allarme a soglia−3 °C; max 1 notifica/h per chiave evento (niente spam a ogni ciclo di poll). Retention 90 gg.
- Opzionale `NOTIFY_WEBHOOK_URL`: POST JSON generico (compatibile Gotify/ntfy/Discord tramite template payload).

## 7. Sicurezza

- **Setup wizard al primo avvio**: crea utente + password (bcrypt cost 12) salvata in SQLite. Env `PASSWORD` usata **solo** come bootstrap iniziale (warning in UI se resta settata dopo il wizard).
- **Sessioni opache in SQLite** al posto dei JWT: token random 256 bit in cookie httpOnly `SameSite=Strict` (+ **`Secure` automatico** dietro reverse proxy HTTPS, coerente con `trust proxy`), in DB solo l'hash; scadenza 24 h scorrevole. Revoca reale (logout, "disconnetti ovunque"), nessun secret da gestire/ruotare.
- **TOTP opzionale** (RFC 6238): secret cifrato at-rest come gli altri segreti, recovery codes monouso.
- Auth **e verifica header `Origin`** sull'handshake socket.io (anti cross-site WebSocket hijacking); stessa verifica (`Origin`/`Sec-Fetch-Site`) **anche sulle route REST mutanti**, come difesa in profondità oltre a `SameSite=Strict`.
- helmet + **CSP restrittiva** (self-only, compatibile con la build Vite).
- `GET /api/health` **esente da auth** (necessario all'HEALTHCHECK); risponde solo `{status:"ok"}`, nessun dato di sistema.
- Rate limit: login 5 tentativi/15 min per IP con backoff; azioni 30/min. `trust proxy` configurabile (SWAG/NPM).
- **Audit log** in SQLite (utente, azione, target, esito, IP), consultabile in UI; retention 90 gg / 20k righe. **Incluse le sessioni exec** (utente, container, esito).
- Conferma digitata (nome risorsa) per: remove container, stop array, kill, **reboot/shutdown host**.
- Segreti (`UNRAID_API_KEY`, credenziali SSH e registry) **cifrati at-rest** AES-256-GCM; mai nei log. Chiave autogenerata in `/config`: protegge da letture accidentali del DB, non da chi ha pieno accesso a `/config` (documentarlo nel README).
- `DISABLE_AUTH=true` ⇒ banner rosso permanente in UI.

## 8. Deploy

### Dockerfile (multi-stage)
- **build**: `node:22-alpine` + `python3 make g++` (compilazione better-sqlite3 su musl) → build frontend Vite + deps prod backend.
- **runtime**: `node:22-alpine` + `tini` (PID 1); solo artefatti. **Niente curl**: `HEALTHCHECK CMD wget -qO /dev/null http://127.0.0.1:8787/api/health || exit 1` (wget è nella busybox di Alpine). Gestione SIGTERM (chiusura pulita di stream, exec, SSH, checkpoint WAL).
- Root necessario per il docker.sock (documentato nel README); **mai `--privileged`**; sempre `--security-opt no-new-privileges=true`; opzionale rootfs read-only + tmpfs `/tmp`.

### Variabili d'ambiente
| Var | Default | Note |
|---|---|---|
| `PORT` | 8787 | |
| `PASSWORD` | — | solo bootstrap primo avvio |
| `UNRAID_HOST` | — | IP/host Unraid |
| `UNRAID_URL` | `http://UNRAID_HOST` | override endpoint GraphQL (https/porta custom) |
| `UNRAID_TLS_INSECURE` | false | accetta cert self-signed sul GraphQL |
| `UNRAID_API_KEY` | — | GraphQL 7.x (mask nel template) |
| `SSH_USER` / `SSH_PASSWORD` o `SSH_KEY` | — | fallback 6.12 |
| `DOCKER_HOST` | unix socket | opzionale (socket-proxy tcp) |
| `DISABLE_AUTH` | false | solo LAN |
| `UPDATE_CHECK_INTERVAL` | 6h | |
| `UPDATE_VERIFY_TIMEOUT` | auto | override verifica post-update |
| `NOTIFY_WEBHOOK_URL` | — | opzionale |
| `TZ` | Europe/Rome | |

### Template XML CA (`my-UnraidDeck.xml`)
- Mounts: `/var/run/docker.sock` (rw), `/config`; **opzionale** `/var/run/libvirt/libvirt-sock`.
- Path `/config` suggerito **diretto** (es. `/mnt/cache/appdata/unraiddeck`); nota SQLite/FUSE nell'Overview.
- ExtraParams: `--security-opt no-new-privileges=true`.
- `WebUI: http://[IP]:[PORT:8787]`, icona, Overview in italiano, Support/Project URL.
- Label `net.unraid.docker.icon` / `net.unraid.docker.webui` applicate al container stesso.

### docker-compose.yml
`restart: unless-stopped`, healthcheck, `security_opt: [no-new-privileges:true]`, mounts + env come sopra.

## 9. Vincoli

- Un solo container, zero servizi esterni.
- Solo stream/eventi Docker API; nessuna shell-out al CLI `docker`; nessun polling della lista **a regime** (sola riconciliazione alla riconnessione dello stream eventi).
- Degradazione elegante: API Unraid giù ⇒ resta operativa la sola parte Docker; errori mostrati con causa + retry.
- Commenti nel codice in **italiano**; stringhe UI centralizzate (pronte per i18n), lingua IT.

## 10. Deliverable

1. Repo completa: `/backend`, `/frontend`, `/docker` (+ `.env.example`).
2. `Dockerfile`, `docker-compose.yml`, `my-UnraidDeck.xml`.
3. `.github/workflows/release.yml`: build **amd64** → push su `ghcr.io` con tag semver + `latest` (il template CA deve puntare a un registry pubblico).
4. `README.md` (IT): installazione su Unraid (CA e manuale), creazione API key 7.x (`unraid-api apikey --create` oppure Settings → Management Access → API Keys), setup fallback SSH per 6.12, note sicurezza/reverse proxy, **nota PWA (install solo via HTTPS)**, **nota SQLite/FUSE (path `/config` diretto o share exclusive)**, backup/ripristino di `/config` (**inclusi i backup automatici SQLite in `/config/backups`**).
5. `CHANGELOG.md`.
