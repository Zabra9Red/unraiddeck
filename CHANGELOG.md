# Changelog

Formato basato su [Keep a Changelog](https://keepachangelog.com/it/1.1.0/); versioni [SemVer](https://semver.org/lang/it/).

## [1.17.0] — 2026-07-15

### Aggiunto — UnraidDeck Cloud (le funzioni di Nextcloud/Seafile/oCIS/Immich/Filebrowser, native)
- **WebDAV nativo su `/dav`**: monta le share da Windows/macOS/Linux/iOS/Android/rclone con qualunque client WebDAV (credenziali dell'app, Basic auth con rate-limit). PROPFIND/GET/PUT/MKCOL/DELETE/MOVE/COPY/LOCK; scritture atomiche e audit. Richiede il mount `/mnt → /unraid`.
- **Tab "Foto"**: galleria timeline (raggruppata per mese) di foto e video dalle share, thumbnail generate server-side (vips/ffmpeg, HEIC incluso) con cache su /config, lightbox col viewer universale.
- **Link di condivisione pubblici** (`/s/<token>`): condividi file o cartelle con chiunque — scadenza opzionale, password opzionale, contatore download, revoca dalla UI; le cartelle mostrano un listing navigabile senza login. Pulsante 🔗 su ogni riga del file manager.

## [1.16.0] — 2026-07-15

### Aggiunto
- **Collabora CODE embedded** (nuova immagine `ghcr.io/zabra9red/unraiddeck:office`): editing Word/Excel/PowerPoint **fedele, stile Nextcloud, tutto dentro il container** — coolwsd supervisionato dal backend (restart automatico, fallback capabilities per container unprivilegiati), proxy same-origin (`/browser`, `/cool`, `/hosting`) con WebSocket autenticato, **WOPI host interno** (token firmati, lock SQLite TTL 30 min, PutFile atomico + versioning + audit). L'immagine base resta invariata; con `:office` i documenti si aprono nell'editor Collabora a schermo pieno.
- Gli editor JS locali rispettano i lock office: salvare da editor testo su un file aperto in Collabora → **423 Locked**.

### Corretto
- **PDF**: viewer pdf.js ovunque (anche senza mount locale/via SFTP) al posto dell'iframe del browser — i PDF si aprono sempre, su qualunque browser.

## [1.15.0] — 2026-07-15

### Aggiunto (Viewer & Editor universale — fase 1)
- **File system locale**: nuovo mount opzionale `/mnt → /unraid` (propagation slave, nel template CA). Quando presente, il file manager lavora in locale (più veloce, streaming con Range); senza, resta il canale SSH/SFTP.
- **Detection sul contenuto**: magic bytes (`file-type`) → `file --mime-type` → euristica testo; l'estensione è solo un hint. File sensibili (chiavi, .env, kdbx) → conferma + audit.
- **Viewer universale** con registry e fallback garantito: immagini (zoom/rotazione), audio/video nativi con seek (Range), **PDF via pdf.js bundlato** (niente CDN), Markdown sanificato (DOMPurify), JSON tree, **editor CodeMirror** per testo/codice con highlight 100+ linguaggi, **hex viewer** per qualsiasi file (finestre da 64 KB). Menu «Apri con…»; nessun file è "non apribile".
- **Salvataggio atomico FUSE-safe**: tmp nella stessa directory + fsync + rename (niente EXDEV su /mnt/user), permessi/owner preservati, encoding/BOM/EOL rilevati e mantenuti, conflitto se il file è cambiato su disco (409).
- **Versioning**: backup `.orig` al primo salvataggio, storico versioni con ripristino dalla UI (`FM_KEEP_VERSIONS`, default 3).
- Binari runtime per le prossime fasi (ffmpeg, libarchive, exiftool, poppler, vips, openssl) inclusi nell'immagine.

## [1.14.0] — 2026-07-14

### Aggiunto
- **Editor Office integrati, tutto dentro UnraidDeck** (nessun container esterno, librerie bundlate):
  - **Fogli di calcolo** (xlsx/xls/ods/xlsm): griglia editabile multi-sheet in-app via SheetJS — modifichi le celle e salvi nel formato originale (stili/formattazione possono semplificarsi).
  - **docx**: anteprima fedele (docx-preview) + modalità "Modifica testo" che salva un docx rigenerato (di default come copia `-modificato.docx`, opzione sovrascrivi).
  - **pptx**: testo estratto slide per slide; **ods/odp/xlsx**: estrazione testo migliorata.
- L'integrazione OnlyOffice resta disponibile come opzione (se `ONLYOFFICE_URL` è impostata ha priorità), ma non è più necessaria.

## [1.13.0] — 2026-07-14

### Aggiunto
- **Editing Office completo (opzionale)** via OnlyOffice Document Server: con `ONLYOFFICE_URL` (+ `ONLYOFFICE_JWT_SECRET` se attivo) i docx/xlsx/pptx si aprono e **modificano** in un editor a schermo pieno dal file manager; il salvataggio riscrive il file sulla share via SFTP (token usa-e-getta per il DS, tutto in audit). Senza OnlyOffice resta l'estrazione testo.

### Corretto
- **PDF di nuovo visualizzabili** nell'anteprima: la CSP dell'app (`object-src 'none'`) veniva applicata anche alla risposta del download e Chrome rifiutava di renderizzare il PDF; ora i file scaricati non portano la CSP dell'app (sicuro: HTML/SVG/JS restano text/plain).

## [1.12.0] — 2026-07-14

### Aggiunto
- **Editor di testo in-app** nel file manager: tutti i file di testo e codice (txt, conf, log, cpp, py, json, …) si modificano e salvano direttamente dal browser (fino a 2 MB).
- **File senza estensione** (o con estensione ignota): il contenuto viene analizzato — se è testo si apre nell'editor, se è binario resta il download più il pulsante "Apri come testo (grezzo)".
- **Documenti Office**: docx/odt/rtf mostrano il testo estratto (lettore ZIP+XML interno, nessuna dipendenza); i .doc legacy usano l'estrazione stile `strings` (approssimativa, segnalata).

## [1.11.0] — 2026-07-14

### Aggiunto
- **File manager** (nuova tab "File"): naviga share e dischi sotto `/mnt` via SFTP (fallback SSH, nessun mount), con anteprima in-app di immagini, video, audio, PDF e testo; download, upload, nuova cartella, rinomina, elimina (in audit). HTML/SVG/JS serviti come testo per non eseguire script sull'origin dell'app.
- **Notifiche inizio/fine update**: ogni update container notifica l'avvio, il completamento (o il fallimento con rollback) — in-app e webhook/ntfy.
- **Range temperatura dischi**: oltre alla soglia massima ora c'è una soglia minima opzionale; allarme se un disco esce dal range (isteresi ±3 °C).

## [1.10.0] — 2026-07-14

### Aggiunto
- **Terminale host Unraid** nella tab Unraid (xterm su shell SSH, PTY con resize, timeout 15 min, max 2 sessioni/utente, audit). Richiede il fallback SSH configurato (`SSH_USER` + `SSH_PASSWORD` o `SSH_KEY`).
- **Aggiornamenti automatici dei container**: toggle in Impostazioni con intervallo configurabile (default 8 ore, 1–168). A ogni ciclo: check aggiornamenti e update sequenziale con la stessa procedura sicura di quello manuale (journal, rollback, dipendenti VPN); UnraidDeck stesso è escluso. Notifica con l'esito.
- **Drill-down nello storico energia**: click su un anno → i suoi mesi, click su un mese → i suoi giorni (con breadcrumb per tornare indietro); API `within=YYYY|YYYY-MM` su `/api/unraid/energy/breakdown`.

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
