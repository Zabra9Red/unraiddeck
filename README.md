# UnraidDeck

🇬🇧 [English version](README.en.md)

> Dashboard all-in-one per Unraid + Docker. **Un solo container, zero dipendenze esterne.**

UnraidDeck unisce in un'unica web UI la gestione completa dei container Docker dell'host Unraid e il monitoraggio/controllo del sistema (array, parity, dischi, pool, share, VM, UPS, alimentazione host).

![stack](https://img.shields.io/badge/Node.js-22%20LTS-a6e3a1) ![stack](https://img.shields.io/badge/React-19-89b4fa) ![stack](https://img.shields.io/badge/SQLite-WAL-cba6f7)

## Caratteristiche

**Docker**
- Lista container con stato, uptime, CPU%, RAM, I/O rete, porte, restart policy, icone (proxate e cacheate: funzionano offline e senza mixed-content dietro HTTPS) e pulsante "Apri WebUI".
- Azioni: start / stop / restart / pause / kill / remove / update / prune immagini dangling — con **lock per-container** (le operazioni concorrenti ricevono 409).
- **Update sicuro**: pull con progresso, clone integrale di `Config`+`HostConfig` (IP statici br0/macvlan preservati), verifica **healthcheck-aware**, **rollback automatico**, journal in SQLite con recovery al riavvio, gestione dei **dipendenti `net=container:`** (pattern VPN).
- **Self-update** tramite helper effimero: UnraidDeck aggiorna sé stesso senza interventi manuali.
- Check aggiornamenti via Registry HTTP API v2 (HEAD: non consuma i rate limit Docker Hub), credenziali opzionali per registry privati, badge "update/pinned/locale".
- Log live (demux stdout/stderr, ricerca, download in streaming), console exec (xterm.js), stats real-time con sparkline e grafici.
- Bulk su selezione multipla (UnraidDeck stesso è sempre escluso).

**Unraid**
- Unraid **7.x**: API GraphQL `unraid-api` con **capability map via introspection** → ogni sezione degrada in autonomia se lo schema non la espone.
- Unraid **6.12**: fallback SSH con parsing di `/var/local/emhttp/*.ini`.
- Array e parity (start/stop/pausa/riprendi/annulla + storico da `/boot/config/parity-checks.log`), dischi con **temperatura e spin state da fonte passiva** (mai smartctl periodico: i dischi in spin-down non vengono svegliati; SMART completo solo on-demand con `-n standby`), pool ZFS/BTRFS, share, VM, **UPS** (apcupsd NIS o NUT via TCP, nessun mount), reboot/shutdown host.

**Sicurezza**
- Setup wizard al primo avvio (bcrypt cost 12), sessioni opache in SQLite (revoca reale, "disconnetti ovunque"), **TOTP opzionale** con recovery codes, audit log completo (incluse le sessioni exec), rate limiting, CSP restrittiva, verifica Origin su REST mutanti e WebSocket, segreti **cifrati at-rest** (AES-256-GCM).
- Conferme digitate per le azioni distruttive (remove, kill, stop array, reboot/shutdown host) e rafforzate per stop/remove di UnraidDeck stesso.

---

## Installazione su Unraid

### Da Community Applications (consigliata)
1. Installa il template `my-UnraidDeck.xml` (o cerca *UnraidDeck* in CA quando pubblicato).
2. **Path `/config`**: usa un percorso **diretto**, es. `/mnt/cache/appdata/unraiddeck`. ⚠️ **Non usare `/mnt/user/...`**: il database SQLite in modalità WAL su FUSE/shfs rischia corruzione. In alternativa, usa una share con **Exclusive access** attivo (in quel caso il path è un bind diretto).
3. Imposta `UNRAID_HOST` e, per Unraid 7.x, `UNRAID_API_KEY` (vedi sotto).
4. Avvia e apri `http://IP:8787`: il wizard crea l'utente amministratore.

### Manuale (docker run)
```bash
docker run -d \
  --name unraiddeck \
  --restart unless-stopped \
  --security-opt no-new-privileges=true \
  -p 8787:8787 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /mnt/cache/appdata/unraiddeck:/config \
  -e UNRAID_HOST=192.168.1.10 \
  -e UNRAID_API_KEY=... \
  -e TZ=Europe/Rome \
  ghcr.io/zabra9red/unraiddeck:latest
```

Oppure con `docker-compose.yml` (incluso nel repo).

### API key per Unraid 7.x
Sul server Unraid:
```bash
unraid-api apikey --create
```
oppure dalla GUI: **Settings → Management Access → API Keys**. Servono i permessi di lettura su array/docker/info e le mutation che vuoi usare (array, vm, reboot/shutdown).

- Se il server forza SSL (redirect https con certificato `myunraid.net` sull'IP locale), imposta `UNRAID_URL=https://IP` e `UNRAID_TLS_INSECURE=true`.

### Fallback SSH per Unraid 6.12
Imposta `SSH_USER` (tipicamente `root`) e `SSH_PASSWORD` **oppure** `SSH_KEY` (percorso di una chiave privata montata in `/config`, o PEM inline). UnraidDeck legge `/var/local/emhttp/*.ini`, usa `mdcmd` per array/parity, `virsh` per le VM, `powerdown` per l'host.

### VM via libvirt (opzionale)
Mount opzionale `/var/run/libvirt/libvirt-sock` (già predisposto nel template). In sua assenza le VM sono gestite via GraphQL (7.x) o `virsh` su SSH (6.12).

---

## Variabili d'ambiente

| Var | Default | Note |
|---|---|---|
| `PORT` | 8787 | |
| `PASSWORD` | — | **solo bootstrap** primo avvio (crea l'utente `admin`); rimuovere dopo il setup (warning in UI) |
| `UNRAID_HOST` | — | IP/host Unraid |
| `UNRAID_URL` | `http://UNRAID_HOST` | override endpoint GraphQL (https/porta custom) |
| `UNRAID_TLS_INSECURE` | `false` | accetta cert self-signed sul GraphQL |
| `UNRAID_API_KEY` | — | GraphQL 7.x |
| `SSH_USER` / `SSH_PASSWORD` o `SSH_KEY` | — | fallback 6.12 |
| `DOCKER_HOST` | unix socket | opzionale (es. socket-proxy tcp) |
| `DISABLE_AUTH` | `false` | solo LAN fidata (banner rosso permanente) |
| `TRUST_PROXY` | — | `true`/IP dietro reverse proxy (cookie `Secure`, IP reali nel rate-limit) |
| `UPDATE_CHECK_INTERVAL` | `6h` | check aggiornamenti (con jitter) |
| `UPDATE_VERIFY_TIMEOUT` | auto | override verifica post-update (default healthcheck-aware) |
| `NOTIFY_WEBHOOK_URL` | — | webhook JSON (Gotify/ntfy/Discord) |
| `TZ` | `Europe/Rome` | |

---

## Sicurezza e reverse proxy

- Il container richiede **root** per l'accesso a `/var/run/docker.sock`: chi controlla il socket controlla l'host. Non esporre mai UnraidDeck direttamente su Internet senza reverse proxy + HTTPS. Mai `--privileged`; sempre `--security-opt no-new-privileges=true`. Rootfs read-only opzionale con tmpfs su `/tmp`.
- Dietro **SWAG / Nginx Proxy Manager**: imposta `TRUST_PROXY=true`. Il cookie di sessione diventa automaticamente `Secure` e il rate limiting usa l'IP reale del client.
- I segreti (API key, credenziali SSH e registry) sono cifrati at-rest con AES-256-GCM. La chiave è autogenerata in `/config/secret.key`: protegge da letture accidentali del database, **non** da chi ha pieno accesso a `/config`.
- `DISABLE_AUTH=true` mostra un banner rosso permanente: usarlo solo su LAN fidata.

## PWA

La UI è installabile come **PWA** (icona in home, standalone). L'installazione richiede **HTTPS** → serve un reverse proxy con certificato valido. Su http la UI resta pienamente usabile, semplicemente senza install.

## Nota SQLite / FUSE (importante)

Il database usa `journal_mode=WAL`, che **non è affidabile su FUSE/shfs** (`/mnt/user`). All'avvio UnraidDeck rileva il filesystem di `/config`: se è FUSE mostra un warning nei log e un banner in UI. Soluzioni:
- path diretto: `/mnt/cache/appdata/unraiddeck` (o il tuo pool), oppure
- share appdata con **Exclusive access** attivo.

## Backup e ripristino di /config

- Backup **automatico giornaliero** del database con `VACUUM INTO /config/backups/` (retention 7 file) + checkpoint WAL periodico e allo shutdown.
- Per il backup completo: ferma il container e copia la directory `/config` (contiene database, backup automatici, chiave segreta e cache icone). Il ripristino è la copia inversa.
- I backup automatici in `/config/backups` sono database completi: per ripristinarne uno, `cp /config/backups/unraiddeck-<data>.db /config/unraiddeck.db` a container fermo.

## Note operative

- **Stats**: campionamento batch one-shot (2s con drawer aperto, 5s con lista), nessuno stream persistente per-container, ring buffer in RAM (niente scritture SQLite per-secondo).
- **Eventi**: la lista è pilotata da `docker events` con auto-reconnect, replay e riconciliazione — nessun polling a regime.
- **Check update**: HEAD sui manifest v2 (inclusi i media type single-manifest per i repo single-arch), token anonimi per Docker Hub/ghcr/lscr/quay, backoff su 429. Container avviati per digest → badge "pinned"; immagini build/import locali → badge "locale".
- **`docker system df`** è solo on-demand (endpoint lento su host grandi).
- I **dipendenti `net=container:`** (VPN) vengono mostrati nella conferma di update e ricreati/riavviati automaticamente dopo l'update del target.

## Sviluppo

```bash
# backend (Node 22)
cd backend && npm install
CONFIG_DIR=./data node src/server.js

# frontend (Vite dev server con proxy verso :8787)
cd frontend && npm install && npm run dev
```

Build immagine completa:
```bash
docker build -t unraiddeck:dev .
```

## Licenza

MIT
