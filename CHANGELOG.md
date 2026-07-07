# Changelog

Formato basato su [Keep a Changelog](https://keepachangelog.com/it/1.1.0/); versioni [SemVer](https://semver.org/lang/it/).

## [1.5.0] — 2026-07-07

### Aggiunto
- **Consumo elettrico dall'UPS**: la potenza assorbita (NUT `ups.realpower` misurata, oppure stimata da potenza nominale × carico — apcupsd `NOMPOWER×LOADPCT`, NUT `realpower.nominal`/`power.nominal`×PF 0,8) viene campionata a ogni poll e integrata in bucket orari SQLite (`ups_energy`, retention 2 anni, gap >5 min scartati). Nella card UPS: potenza attuale, kWh oggi/ieri/7g/30g/anno, grafico della potenza media oraria (24h) e **costo in €** con prezzo €/kWh configurabile — preset indicativi dei principali fornitori italiani (Enel, Eni Plenitude, Edison, A2A, Iren, Sorgenia, Octopus, ARERA tutela) o valore manuale della bolletta. API: `GET /api/unraid/energy`, `POST /api/unraid/energy/config`.

## [1.4.2] — 2026-07-07

### Corretto
- **GraphQL con introspection disabilitata** (`INTROSPECTION_DISABLED`, default di unraid-api in produzione): ora UnraidDeck ripiega su uno schema statico compatibile 7.x e rimuove automaticamente i campi che il server rifiuta (`Cannot query field …`), quindi la tab Unraid funziona senza abilitare la developer sandbox.
- Gli errori GraphQL restituiti con status HTTP 400 vengono estratti dal body JSON invece di apparire come errore HTTP grezzo.
- Template CA/compose: il mount libvirt opzionale ora è la **directory** `/var/run/libvirt` e non il file socket — bind del file crea una race al boot che può lasciare giù il sottosistema VM (issue #1, grazie @junkerderprovinz).

## [1.4.1] — 2026-07-06

### Corretto
- **GraphQL con "Use SSL: Yes"**: il client ora segue i redirect (302 → `https://<hash>.myunraid.net/graphql`), quindi basta `UNRAID_HOST` anche con SSL forzato; errori certificato suggeriscono `UNRAID_TLS_INSECURE=true`.
- **Diagnostica connessione Unraid in UI**: con host configurato ma API non raggiungibile la tab Unraid mostra l'errore reale e i passi per risolvere (API key, UNRAID_URL, SSH), invece del messaggio generico "Non configurato".
- Download log in streaming reale dal socket Docker (prima dockerode bufferizzava l'intero log in RAM con `follow:false`).

## [1.4.0] — 2026-07-03

Prima release pubblica (spec v1.4).

### Aggiunto
- **Docker**: lista container con stats real-time (batch one-shot, intervallo adattivo 2s/5s, ring buffer 120 punti in RAM), sparkline e grafici estesi nel drawer, log live con demux e coalescing ≤100ms, console exec xterm.js (timeout 15 min, max 3 sessioni/utente), bulk con `p-limit(3)`.
- **Update sicuro**: pull con progresso, clone integrale `Config`+`HostConfig`, reti multiple con IP/MAC/alias preservati (create multi-endpoint su API ≥1.44), verifica healthcheck-aware, rollback automatico, journal SQLite con recovery all'avvio e pulizia residui `-old-*`.
- **Dipendenti `net=container:`** (pattern VPN): rilevati prima dell'update, mostrati in conferma, ricreati/riavviati dopo.
- **Self-update** via helper effimero (`net.unraiddeck.helper=1`, AutoRemove, GC zombie all'avvio); UnraidDeck escluso dal bulk; conferma rafforzata per stop/remove di sé stesso.
- **Check aggiornamenti**: Registry HTTP API v2 con HEAD (tutti i media type incl. single-manifest), token anonimi per-registry, credenziali opzionali cifrate per repo privati (check e pull), timeout 10s, `p-limit(4)`, backoff su 429, cache SQLite, badge "pinned"/"locale", intervallo 6h con jitter.
- **Unraid 7.x**: GraphQL `unraid-api` con negoziazione capability via **introspection** (query composte solo sui campi presenti nello schema), degradazione per-sezione, `UNRAID_URL` + `UNRAID_TLS_INSECURE` per SSL self-signed, subscription notifiche se disponibile.
- **Unraid 6.12**: fallback SSH persistente con keep-alive e backoff (var/disks/shares.ini, mdcmd, zpool/btrfs, virsh, powerdown, sensors).
- **Dischi**: temperatura e spin state sempre da fonte passiva (mai smartctl periodico), SMART on-demand con `-n standby`, storico parity da `/boot/config/parity-checks.log`.
- **UPS**: apcupsd NIS (tcp/3551) o NUT (tcp/3493) via TCP diretto, auto-rilevamento.
- **Power host**: reboot/shutdown (mutation GraphQL o `powerdown` SSH) con conferma digitata.
- **Notifiche**: in-app + SQLite (temp dischi con isteresi −3°C, errori parity, pool degradati, container exit≠0, update disponibili, UPS on-battery), cooldown 1/h per chiave, retention 90gg, webhook JSON opzionale (Gotify/ntfy/Discord).
- **Sicurezza**: setup wizard (bcrypt 12), sessioni opache in SQLite con revoca reale, TOTP RFC 6238 con recovery codes, audit log (90gg/20k righe, incluse sessioni exec), rate limit login con backoff, helmet+CSP self-only, verifica Origin su REST mutanti e handshake socket.io, segreti AES-256-GCM at-rest, `DISABLE_AUTH` con banner rosso.
- **Persistenza**: SQLite WAL + busy_timeout, checkpoint periodico e su shutdown, backup giornaliero `VACUUM INTO` (retention 7), guard FUSE/shfs con warning e banner UI.
- **Deploy**: immagine multi-stage `node:22-alpine` (amd64) con tini e HEALTHCHECK wget, `docker-compose.yml`, template CA `my-UnraidDeck.xml`, workflow release su ghcr.io (semver + latest).
- **UI**: React 19 + Vite + Tailwind v4, tema Catppuccin Mocha, responsive, PWA (install via HTTPS), lingua IT con stringhe centralizzate.
