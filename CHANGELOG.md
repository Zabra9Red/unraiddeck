# Changelog

Formato basato su [Keep a Changelog](https://keepachangelog.com/it/1.1.0/); versioni [SemVer](https://semver.org/lang/it/).

## [1.9.1] — 2026-07-08

### Corretto
- Il webhook ora considera errore le risposte HTTP non-2xx e le logga con lo status (`[notify] webhook fallito: HTTP 404 …`), prima passavano in silenzio.

## [1.9.0] — 2026-07-08

### Aggiunto
- **Allarmi consumo** (tab Energia): soglia potenza in W (isteresi −10 %) e limite giornaliero in kWh (una notifica al giorno, con costo). Le notifiche arrivano in-app e sul webhook.
- **Supporto ntfy nativo**: se `NOTIFY_WEBHOOK_URL` punta a ntfy (auto-rilevato, o forzato con `NOTIFY_WEBHOOK_TYPE=ntfy`) la notifica usa il formato nativo (titolo "UnraidDeck: …", priorità, tag) → push puliti su iPhone/Android con l'app ufficiale gratuita. Guida nel README.
- **La tab attiva sopravvive al refresh** (hash URL + localStorage): niente ritorno forzato alla home.

## [1.8.0] — 2026-07-08

### Aggiunto
- **Storico consumi ordinabile** nella tab Energia: tabella per giorno/settimana/mese/anno con ordinamento per data o per costo (crescente/decrescente) cliccando le intestazioni.

## [1.7.1] — 2026-07-07

### Aggiunto
- **Footer con versione corrente** centrato in fondo alla UI, link alle release GitHub.

### Corretto
- L'immagine Docker ora riceve davvero la versione dal tag di release (`ARG UNRAIDDECK_VERSION` mancante nel Dockerfile): la versione mostrata coincide sempre con la release GitHub.

## [1.7.0] — 2026-07-07

### Aggiunto
- **Tab "Energia"**: dashboard UPS in stile Grafana — tiles consumo/costo (oggi, ieri, 7g, 30g, anno, stima annua, costo medio giornaliero), gauge radiali batteria e carico, potenza attuale in tempo reale via socket, grafico potenza 24h, bar chart consumo giornaliero (30 gg) e mensile (12 mesi) con costi al passaggio del mouse, configurazione prezzo €/kWh. La sezione energia lascia la card UPS della tab Unraid (che mantiene stato e diagnostica) e vive nella nuova tab.

## [1.6.1] — 2026-07-07

### Corretto
- **Schema statico: auto-riparazione anche con nomi tipo diversi** — il server può chiamare un tipo diversamente dallo schema statico (es. `InfoVersions`): ora il pruning dei campi rifiutati matcha per somiglianza di nome e, in ultima istanza, per solo nome campo, quindi la sezione si auto-ripara invece di restare in errore ("Sezione non disponibile: Cannot query field \"unraid\" on type \"InfoVersions\"").
- **Diagnostica UPS**: quando l'UPS non è rilevato la card mostra il motivo reale per protocollo (`apcupsd:3551 → timeout`, `NUT:3493 → ECONNREFUSED`, host mancante) e i passi per risolvere (servizio UPS su Unraid, `LISTEN 0.0.0.0` per NUT), invece del generico "UPS non rilevato".

## [1.6.0] — 2026-07-07

### Aggiunto
- **UPS quasi in tempo reale**: poll ogni 10 s (era 60 s), configurabile con `POLL_UPS`; stato e potenza arrivano in UI via socket a ogni poll.
- **Storico consumi per giorno / settimana / mese / anno** con costo per periodo (`GET /api/unraid/energy/breakdown?granularity=day|week|month|year`), selettore nella card UPS. I dati restano in SQLite su `/config` e sopravvivono a riavvii di container e host (retention 2 anni).

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
