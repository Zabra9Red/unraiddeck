# Pubblicazione UnraidDeck

## 1. Push su GitHub

Crea il repo **pubblico** `unraiddeck` su https://github.com/new (owner `Zabra9Red`, senza README iniziale), poi da questa directory:

```bash
git push -u origin main --follow-tags
```

Il tag `v1.4.0` fa partire `.github/workflows/release.yml`: build amd64 → push su `ghcr.io/zabra9red/unraiddeck` con tag `1.4.0`, `1.4` e `latest`.

> Se preferisci HTTPS a SSH:
> `git remote set-url origin https://github.com/Zabra9Red/unraiddeck.git`

## 2. Rendi pubblica l'immagine ghcr

Al primo push il package è privato:
GitHub → profilo → **Packages** → `unraiddeck` → **Package settings** → **Change visibility** → *Public*.

Verifica: `docker pull ghcr.io/zabra9red/unraiddeck:latest` da una macchina qualsiasi senza login.

## 3. Installazione manuale su Unraid (subito, senza CA)

```bash
# dal PC:
scp docker/my-UnraidDeck.xml root@TUO-UNRAID:/boot/config/plugins/dockerMan/templates-user/
```

Poi GUI Unraid → **Docker** → **Add Container** → selezione template **UnraidDeck** → compila `UNRAID_HOST`, `UNRAID_API_KEY` (7.x: `unraid-api apikey --create`), path `/config` diretto (es. `/mnt/cache/appdata/unraiddeck`) → **Apply**.

## 4. Inclusione in Community Applications

Prerequisiti (già a posto in questo repo):
- [x] repo GitHub pubblico con il template XML (`docker/my-UnraidDeck.xml`)
- [x] immagine su registry pubblico (ghcr)
- [x] icona raggiungibile via URL raw GitHub
- [x] `Support` e `Project` URL nel template

Passi:
1. Crea un thread di supporto nella sezione **Docker Containers** del forum Unraid: https://forums.unraid.net/forum/47-docker-containers/ (testo pronto sotto). Metti l'URL del thread nel campo `<Support>` del template (aggiorna il file e ricommitta).
2. Chiedi l'inclusione del repository template in CA: cerca nel forum il thread ufficiale **"Community Applications — Application Policies"** di Squid (maintainer CA) e segui le istruzioni per registrare il tuo *template repository* (in genere: risposta nel thread o segnalazione a Squid con il link del repo GitHub).
3. Dopo l'approvazione, l'app appare in CA cercando "UnraidDeck". Le release successive: basta pushare un nuovo tag `vX.Y.Z` (l'immagine `latest` viene aggiornata) — CA rileva i template dal repo, nessun altro passo.

## 5. Testo pronto per il thread forum (EN)

---

**Title:** [Support] UnraidDeck — all-in-one dashboard for Unraid + Docker (single container)

UnraidDeck is a single-container web dashboard that combines full Docker management with Unraid system monitoring. No external dependencies, no agents.

**Docker features**
- Container list with live CPU/RAM/network stats, sparklines, ports, restart policy, icons and "Open WebUI" button
- Start / stop / restart / pause / kill / remove / update / prune, with per-container locking and bulk actions
- Safe updates: image pull with progress, full config clone (static IPs on br0/macvlan preserved), health-check-aware verification, automatic rollback, update journal with crash recovery
- VPN pattern supported: containers using `--net=container:X` are detected and recreated/restarted automatically when X is updated
- Self-update via ephemeral helper container
- Registry update checks (HEAD requests — they don't consume Docker Hub pull rate limits), private registry credentials supported
- Live logs (search, streaming download), in-browser console (xterm.js)

**Unraid features**
- Unraid 7.x: official GraphQL API with capability detection via introspection (each section degrades gracefully)
- Unraid 6.12: SSH fallback (emhttp ini parsing)
- Array & parity control with history, disk temps from passive sources (never wakes spun-down disks; SMART on demand with `-n standby`), ZFS/BTRFS pool health, shares, VMs, UPS (apcupsd/NUT over TCP), host reboot/shutdown
- Notifications with hysteresis + cooldown, optional webhook (Gotify/ntfy/Discord)

**Security**
- First-run setup wizard, opaque sessions, optional TOTP 2FA with recovery codes, full audit log, rate limiting, strict CSP, secrets encrypted at rest
- Typed confirmations for destructive actions

**Install**
- Community Applications (pending) or template XML from the repo
- Image: `ghcr.io/zabra9red/unraiddeck:latest` (amd64)
- ⚠️ Use a direct path for `/config` (e.g. `/mnt/cache/appdata/unraiddeck`), not `/mnt/user/...` — SQLite WAL on FUSE risks corruption. The app warns you if misconfigured.

**Links**
- Project: https://github.com/Zabra9Red/unraiddeck
- Issues: https://github.com/Zabra9Red/unraiddeck/issues

Feedback and bug reports welcome!

---
