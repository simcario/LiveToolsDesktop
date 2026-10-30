# Rilasciare una versione di LiveTools Desktop

Procedura per pubblicare un aggiornamento di LiveTools Desktop (Windows). Lo script che fa il lavoro è
[`scripts/release.mjs`](../scripts/release.mjs); qui c'è il *come* e il *quando*.

## Come funziona

```
release.mjs ──build──▶ release/v<x.y.z>/  LiveTools_<x.y.z>_x64-setup.exe
                                          LiveTools_<x.y.z>_x64-setup.exe.sig
                                          latest.json
            ──publish─▶ GitHub Release v<x.y.z> su simcario/LiveTools-releases (pubblico)
                                          │
app installata ── all'avvio legge ────────┘ releases/latest/download/latest.json
               ── verifica la firma e installa da Impostazioni › Aggiornamenti
```

- Il codice resta nel repo privato; nel repo **pubblico** `simcario/LiveTools-releases` ci sono solo gli
  installer, così l'updater scarica senza autenticazione.
- La release resta **in bozza** finché tutti i file non sono caricati: le app non vedono mai un
  `latest.json` senza il suo installer.
- L'app non installa mai da sola: segnala e basta. L'utente installa da *Impostazioni › Aggiornamenti*.

## Prerequisiti (una tantum, sul PC di build)

| Cosa | Dove | Note |
|---|---|---|
| Chiave di firma | `%USERPROFILE%\.tauri\livetools.key` (+ `.pub`) | la pubblica è in `tauri.conf.json` → `plugins.updater.pubkey`. **Tienine un backup fuori dal PC**: senza, le app installate non si aggiornano più e vanno reinstallate a mano |
| Token GitHub | `%USERPROFILE%\.tauri\github-token` o variabile `GITHUB_TOKEN` | fine-grained con *Contents: Read and write* sul repo delle release (classico con `repo` solo se il repo va creato) |
| Toolchain Rust GNU | `rustup toolchain install stable-x86_64-pc-windows-gnu` | sul PC attuale la toolchain MSVC non linka; `LIVETOOLS_TOOLCHAIN` per cambiarla |
| MinGW | `scoop install mingw` | lo script aggiunge `%USERPROFILE%\scoop\apps\mingw\current\bin` al PATH |
| Credenziali OAuth | `desktop/.env` o variabili `LIVETOOLS_GOOGLE_CLIENT_ID/SECRET` | vengono incluse nella build da `build.rs`: senza, il login nell'installer non funziona |

Chiave e token non vanno **mai** nel repo.

## Numerazione

`MAJOR.MINOR.PATCH`:

- **patch** — correzioni, nessun cambiamento di dati o comportamento visibile;
- **minor** — nuove funzioni, compatibili con l'app web e con i dati esistenti;
- **major** — cambi incompatibili (struttura dati Firestore/Storage, regole) che richiedono di aggiornare
  insieme web e desktop.

La versione è scritta in `package.json`, `src-tauri/tauri.conf.json` e `src-tauri/Cargo.toml`: la cambia lo
script, non a mano.

## Checklist

### Prima

- [ ] Niente concerti della band nelle prossime ore (le app segnalano l'aggiornamento all'avvio).
- [ ] Se il desktop usa codice condiviso modificato: `npm run sync-shared` e verifica che il web corrispondente
      sia già pubblicato (`git push` di `web/`, e `npm run deploy:rules` se cambiano le regole).
- [ ] Prova in sviluppo (`npm run app:gnu`): login, caricamento di una scaletta, play con click e video,
      Arrangement, Gobbo, cambio brano.
- [ ] Test del motore: tempo.rs e resample.rs (vedi README, i binari di test della lib non partono su questo PC).
- [ ] Working tree pulito (`git status`), tutto committato.
- [ ] Scrivi le note: aggiungi la sezione in [`CHANGELOG.md`](../CHANGELOG.md) e un file
      `docs/release-notes/v<x.y.z>.md` (vedi sotto).

### Build e pubblicazione

```powershell
cd desktop
npm run release -- patch --notes-file docs/release-notes/v0.1.1.md   # oppure minor | major | 1.2.0
```

La build completa richiede circa **12 minuti** (LTO). Al termine lo script stampa il link della release.

Varianti:

```powershell
npm run installer                                                   # solo installer della versione corrente, niente upload
npm run release:publish -- --notes-file docs/release-notes/v0.1.0.md  # ripubblica l'installer già compilato (es. per correggere le note)
npm run release -- 0.1.1 --notes-file …                             # se la build è fallita dopo il cambio di versione
```

Lo script rifiuta di pubblicare una versione più vecchia di quella già *latest* su GitHub.

### Dopo

- [ ] `git commit -am "v<x.y.z>"` e `git tag v<x.y.z>` (lo script lo ricorda ma non lo fa).
- [ ] Controlla la release su <https://github.com/simcario/LiveTools-releases/releases>: tre file
      (`.exe`, `.exe.sig`, `latest.json`), non in bozza, marcata *Latest*.
- [ ] Su un PC con la versione precedente: *Impostazioni › Aggiornamenti › Cerca aggiornamenti* → compare la
      nuova versione con le note → *Installa* → l'app si riapre con la versione nuova.
- [ ] Avvisa la band (vedi testo d'esempio sotto).

## Note di rilascio

Le note finiscono in `latest.json`, nel corpo della release GitHub **e nell'app**, dove sono mostrate come
testo semplice (a capo rispettati, markdown non interpretato). Quindi:

- niente titoli `#`, tabelle o link markdown; liste con `- ` vanno bene;
- scritte per i musicisti, non per gli sviluppatori: cosa cambia per loro e cosa devono fare;
- brevi (5–10 righe); il dettaglio tecnico va nel CHANGELOG.

Modello (`docs/release-notes/v<x.y.z>.md`):

```text
Novità
- …

Correzioni
- …

Da sapere
- … (azioni richieste, es. "aggiornate anche la pagina web ricaricandola")
```

Messaggio per la band (es. WhatsApp):

```text
È uscita LiveTools Desktop <x.y.z>. Aprite l'app → Impostazioni (Ctrl+,) → Aggiornamenti → Installa.
Novità: <una riga>. Non aggiornate a ridosso del concerto.
```

## Se qualcosa va storto

| Problema | Soluzione |
|---|---|
| `Chiave di firma degli aggiornamenti mancante` | ripristina `livetools.key` dal backup. Se è persa: `npx tauri signer generate -w "%USERPROFILE%\.tauri\livetools.key"`, aggiorna `pubkey` in `tauri.conf.json` e fai reinstallare l'app a tutti a mano |
| `Token GitHub mancante` / HTTP 401 | rigenera il token e salvalo in `github-token` |
| `Su GitHub c'è già la vX, più recente` | aumenta la versione |
| Build fallita dopo il cambio di versione | correggi e rilancia con la versione esatta: `npm run release -- <x.y.z>` |
| Upload interrotto | la release è rimasta in bozza (le app non la vedono): `npm run release:publish` |
| Versione pubblicata difettosa | non si può "ritirare" per chi l'ha già installata: pubblica subito una patch. Per fermare chi non ha ancora aggiornato, rimetti in bozza la release su GitHub (torna *latest* la precedente) |
