# UnraidDeck

🇮🇹 [Versione italiana](README.md)

> All-in-one dashboard for Unraid + Docker. **A single container, zero external dependencies.**

UnraidDeck combines full Docker container management and Unraid system monitoring/control (array, parity, disks, pools, shares, VMs, UPS, host power) in a single web UI.

![stack](https://img.shields.io/badge/Node.js-22%20LTS-a6e3a1) ![stack](https://img.shields.io/badge/React-19-89b4fa) ![stack](https://img.shields.io/badge/SQLite-WAL-cba6f7)

## Features

**Docker**
- Container list with state, uptime, CPU%, RAM, network I/O, ports, restart policy, icons (proxied and cached: they work offline and avoid mixed-content behind HTTPS) and an "Open WebUI" button.
- Actions: start / stop / restart / pause / kill / remove / update / prune dangling images — with **per-container locking** (concurrent operations get a 409).
- **Safe updates**: pull with progress, full `Config`+`HostConfig` clone (static IPs on br0/macvlan preserved), **health-check-aware** verification, **automatic rollback**, SQLite journal with crash recovery on startup, handling of **`net=container:` dependents** (VPN pattern).
- **Self-update** via an ephemeral helper container: UnraidDeck updates itself with no manual steps.
- Update checks via Registry HTTP API v2 (HEAD requests: they don't consume Docker Hub pull rate limits), optional credentials for private registries, "update/pinned/local" badges.
- Live logs (stdout/stderr demux, search, streaming download), exec console (xterm.js), real-time stats with sparklines and charts.
- Bulk actions on multi-selection (UnraidDeck itself is always excluded).

**Unraid**
- Unraid **7.x**: `unraid-api` GraphQL with a **capability map built via introspection** → each section degrades independently if the schema doesn't expose it.
- Unraid **6.12**: SSH fallback parsing `/var/local/emhttp/*.ini`.
- Array and parity (start/stop/pause/resume/cancel + history from `/boot/config/parity-checks.log`), disks with **temperature and spin state from passive sources** (never periodic smartctl: spun-down disks are not woken up; full SMART only on demand with `-n standby`), ZFS/BTRFS pools, shares, VMs, **UPS** (apcupsd NIS or NUT over plain TCP, no mounts), host reboot/shutdown.
- **Host terminal** right in the UI (xterm over SSH, with the SSH fallback configured) and optional **automatic container updates** on a configurable interval (default 8 hours; same safe procedure as manual updates, UnraidDeck itself excluded).
- **Share file manager** (Files tab, over SFTP): in-browser preview of images/video/audio/PDF/text, download, upload, rename, delete; notifications when each container update starts and finishes; disk temperature alerts with a min–max range.
- **Energy tab — near-real-time power consumption from the UPS** (polled every 10 s, tune with `POLL_UPS`): Grafana-style dashboard with battery/load gauges, current draw, per-period consumption/cost tiles and yearly estimate; power measured via `ups.realpower` or estimated from nominal power × load, integrated into kWh with an hourly chart and a **day / week / month / year breakdown, costs included**. The **cost in €** uses your electricity price per kWh (indicative presets for major Italian providers — Enel, Eni Plenitude, Edison, A2A, Iren, Sorgenia, Octopus — or a manual value). Data is **persisted on disk in `/config`** (SQLite): container or server restarts don't lose it; 2-year retention.

**Security**
- First-run setup wizard (bcrypt cost 12), opaque sessions in SQLite (real revocation, "log out everywhere"), **optional TOTP** with recovery codes, full audit log (exec sessions included), rate limiting, strict CSP, Origin verification on mutating REST routes and WebSocket handshake, secrets **encrypted at rest** (AES-256-GCM).
- Typed confirmations for destructive actions (remove, kill, array stop, host reboot/shutdown), reinforced for stopping/removing UnraidDeck itself.

---

## Installing on Unraid

### From Community Applications (recommended)
1. Install the `my-UnraidDeck.xml` template (or search for *UnraidDeck* in CA once published).
2. **`/config` path**: use a **direct** path, e.g. `/mnt/cache/appdata/unraiddeck`. ⚠️ **Do not use `/mnt/user/...`**: SQLite in WAL mode on FUSE/shfs risks corruption. Alternatively use a share with **Exclusive access** enabled.
3. Set `UNRAID_HOST` and, on Unraid 7.x, `UNRAID_API_KEY` (see below).
4. Start it and open `http://IP:8787`: the wizard creates the admin user.

### Manual (docker run)
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

Or use the included `docker-compose.yml`.

### API key on Unraid 7.x
On the Unraid server:
```bash
unraid-api apikey --create
```
or from the GUI: **Settings → Management Access → API Keys**. It needs read permissions on array/docker/info plus the mutations you want to use (array, vm, reboot/shutdown).

- If the server forces SSL (https redirect with the `myunraid.net` certificate on the local IP), set `UNRAID_URL=https://IP` and `UNRAID_TLS_INSECURE=true`.

### SSH fallback for Unraid 6.12
Set `SSH_USER` (typically `root`) and `SSH_PASSWORD` **or** `SSH_KEY` (path of a private key mounted under `/config`, or inline PEM). UnraidDeck reads `/var/local/emhttp/*.ini`, uses `mdcmd` for array/parity, `virsh` for VMs, `powerdown` for the host.

### VMs via libvirt (optional)
Optional mount of the `/var/run/libvirt` **directory** (already wired in the template). Do not bind the `libvirt-sock` file directly: if the container starts before libvirtd, Docker creates the missing bind source as a directory and the VM subsystem fails to come up. Without the mount, VMs are managed via GraphQL (7.x) or `virsh` over SSH (6.12).

---

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `PORT` | 8787 | |
| `PASSWORD` | — | **bootstrap only** on first run (creates the `admin` user); remove after setup (UI warning) |
| `UNRAID_HOST` | — | Unraid IP/host |
| `UNRAID_URL` | `http://UNRAID_HOST` | GraphQL endpoint override (https/custom port) |
| `UNRAID_TLS_INSECURE` | `false` | accept self-signed certs on GraphQL |
| `UNRAID_API_KEY` | — | GraphQL 7.x |
| `SSH_USER` / `SSH_PASSWORD` or `SSH_KEY` | — | 6.12 fallback |
| `DOCKER_HOST` | unix socket | optional (e.g. tcp socket-proxy) |
| `DISABLE_AUTH` | `false` | trusted LAN only (permanent red banner) |
| `TRUST_PROXY` | — | `true`/IP behind reverse proxy (`Secure` cookies, real IPs in rate-limit) |
| `UPDATE_CHECK_INTERVAL` | `6h` | update checks (with jitter) |
| `UPDATE_VERIFY_TIMEOUT` | auto | post-update verification override (default health-check-aware) |
| `NOTIFY_WEBHOOK_URL` | — | notification webhook (native ntfy auto-detected; JSON for Gotify/Discord) |
| `NOTIFY_WEBHOOK_TYPE` | auto | force `ntfy` (self-hosted on a custom domain) or `json` |
| `POLL_UPS` | `10s` | UPS/power polling interval |
| `ONLYOFFICE_URL` | — | OnlyOffice Document Server URL to open/edit Office documents (optional) |
| `ONLYOFFICE_JWT_SECRET` | — | Document Server JWT secret (if enabled) |
| `TZ` | `Europe/Rome` | |

---

## Office documents (optional, via OnlyOffice)

The file manager opens and **edits** docx/xlsx/pptx (and views doc/odt/rtf/xls/ppt…) like a real Office suite by integrating **OnlyOffice Document Server**:

1. Install **OnlyOffice Document Server** from Community Applications (separate container).
2. On UnraidDeck set `ONLYOFFICE_URL=http://IP:PORT` and, if the DS has JWT enabled (default on recent versions), `ONLYOFFICE_JWT_SECRET` with the same secret as the DS.
3. Office documents in the Files tab open in a full-screen editor; saving writes the file back to the share.

Without OnlyOffice, documents still show their extracted text (read-only).

---

## Push notifications on your phone (free, no paid third-party apps)

Every UnraidDeck notification (consumption alerts, hot disks, UPS on battery, available updates…) can reach your **iPhone/Android** through [ntfy](https://ntfy.sh) — a free, open-source app on the **official App Store / Play Store**:

1. Install **ntfy** from the store and subscribe to a topic with an unguessable name (e.g. `unraiddeck-x7k2m9` — topics are public, the name acts as the password).
2. Set `NOTIFY_WEBHOOK_URL=https://ntfy.sh/unraiddeck-x7k2m9` on the container (the ntfy format is auto-detected).
3. In the **Energy tab → Consumption alerts** set the **power threshold (W)** and/or the **daily limit (kWh)**: crossing them triggers the push (power with −10 % hysteresis, daily limit once per day).

---

## Security and reverse proxy

- The container needs **root** for `/var/run/docker.sock` access: whoever controls the socket controls the host. Never expose UnraidDeck directly to the Internet without a reverse proxy + HTTPS. Never `--privileged`; always `--security-opt no-new-privileges=true`. Optional read-only rootfs with tmpfs on `/tmp`.
- Behind **SWAG / Nginx Proxy Manager**: set `TRUST_PROXY=true`. The session cookie automatically becomes `Secure` and rate limiting uses the real client IP.
- Secrets (API key, SSH and registry credentials) are encrypted at rest with AES-256-GCM. The key is auto-generated at `/config/secret.key`: it protects against accidental database reads, **not** against someone with full `/config` access.
- `DISABLE_AUTH=true` shows a permanent red banner: trusted LAN only.

## PWA

The UI is installable as a **PWA** (home icon, standalone). Installation requires **HTTPS** → a reverse proxy with a valid certificate. Over plain http the UI stays fully usable, just without install.

## SQLite / FUSE note (important)

The database uses `journal_mode=WAL`, which is **not reliable on FUSE/shfs** (`/mnt/user`). On startup UnraidDeck detects the `/config` filesystem: if it's FUSE it logs a warning and shows a UI banner. Fixes:
- direct path: `/mnt/cache/appdata/unraiddeck` (or your pool), or
- appdata share with **Exclusive access** enabled.

## Backing up and restoring /config

- **Automatic daily** database backup via `VACUUM INTO /config/backups/` (7-file retention) + periodic WAL checkpoint and on shutdown.
- Full backup: stop the container and copy the `/config` directory (database, automatic backups, secret key, icon cache). Restore is the reverse copy.
- Automatic backups in `/config/backups` are complete databases: to restore one, `cp /config/backups/unraiddeck-<date>.db /config/unraiddeck.db` with the container stopped.

## Operational notes

- **Stats**: one-shot batch sampling (2s with the drawer open, 5s with the list only), no persistent per-container streams, in-RAM ring buffer (no per-second SQLite writes).
- **Events**: the list is driven by `docker events` with auto-reconnect, replay and reconciliation — no steady-state polling.
- **Update checks**: HEAD on v2 manifests (including single-manifest media types for single-arch repos), anonymous tokens for Docker Hub/ghcr/lscr/quay, backoff on 429. Digest-pinned containers → "pinned" badge; locally built/imported images → "local" badge.
- **`docker system df`** is on-demand only (slow endpoint on large hosts).
- **`net=container:` dependents** (VPN) are shown in the update confirmation and automatically recreated/restarted after the target updates.

## Development

```bash
# backend (Node 22)
cd backend && npm install
CONFIG_DIR=./data node src/server.js

# frontend (Vite dev server proxying to :8787)
cd frontend && npm install && npm run dev
```

Full image build:
```bash
docker build -t unraiddeck:dev .
```

## License

MIT
