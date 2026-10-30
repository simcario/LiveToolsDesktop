# LiveTools Desktop

Player di **sequenze multitraccia, click e video** per le scalette di LiveTools, per Windows, macOS e Linux.
Stesso progetto Firebase, stesso account Google e stessa grafica dell'app web (`../web`).

Documentazione: [manuale d'uso](docs/MANUALE.md) · [come rilasciare una versione](docs/RELEASE.md) ·
[changelog](CHANGELOG.md).

- **Tauri 2**: backend in **Rust** (motore audio), interfaccia in React con il design system "Stage Obsidian Amber".
- **Motore audio nativo** (`src-tauri/src/audio`): cpal (WASAPI / CoreAudio / ALSA-JACK) + Symphonia
  (wav, aiff, flac, mp3, ogg, m4a/aac, alac), streaming da disco con ring buffer lock-free, resampling,
  mix sample-accurate, mute/solo/volume/pan, **routing per ruolo su uscite multicanale**, click generato
  dal motore con count-in e cambi di tempo/metro per sezione (stesse regole del metronomo web).
- **Video** sincronizzato all'orologio audio, in anteprima e su una **seconda finestra** per proiettore
  (doppio clic: schermo intero).

## Interfaccia (stile Ableton Live)

| Area | Contenuto |
|---|---|
| Control bar | ⏮ ▶ ■ ⏭, posizione battuta.movimento + tempo, BPM/metro/tonalità, count-in, click, auto-avanzamento, *Segui palco* / *Guida*, Session ⇄ Arrangement, scheda audio |
| Browser (sinistra) | scalette dell'utente, brani con stato dei media offline, "Scarica tutta la scaletta" |
| **Session** (griglia) | colonne = tracce (stem con lo stesso nome in tutta la scaletta), righe = brani/scene; ▶ a destra avvia la scena; mixer in basso (fader, meter, M/S), click e master |
| **Arrangement** (tracce) | timeline del brano nel player: righello battute dalla mappa tempo, locator delle sezioni, forme d'onda, corsia video e click, testina che segue; header tracce a destra con M/S, volume, uscita, meter. Ctrl+rotella = zoom |
| Dettaglio (sotto) | dati del brano, tracce e stato download, anteprima video |
| Pagine (barra di stato) | **Live** (player: Session, Arrangement, Gobbo) e **Scaletta** (modifica), come le pagine di un editor video; Ctrl+1 / Ctrl+2 |

### Pagina Scaletta (modifica)

La stessa modifica dell'app web, sugli stessi documenti: inserimento rapido di brani e blocchi (pausa,
discorso, separatore), riordino trascinando la maniglia o con ↑/↓, eliminazione, valori delle colonne
personalizzate nella lista, titolo della scaletta. A destra l'ispettore del brano selezionato con le schede
Brano, Palco, Spartito, **Testo gobbo**, **Sequenze & Video**, MIDI, Colonne: si salva con *Salva* / **Ctrl+S** e, se si cambia
brano o pagina, in automatico. Ogni modifica va nello storico della scaletta. Colonne e condivisione restano
nell'app web.

**Sequenze & Video** carica stem e video come il web (pulsante o trascinamento dei file sulla scheda), con
ruolo, nome, ordine, mute di default, offset del video ed eliminazione; le modifiche si salvano subito. I
caricamenti continuano anche cambiando brano o pagina, e ogni file viene copiato nella cache locale, quindi
è subito pronto da suonare senza riscaricarlo.

### Griglia allineata all'audio

Al caricamento di un brano il click dell'app, il count-in e il righello si allineano alle tracce:

- **traccia click presente** (ruolo Click o nome "click"/"metronomo"): vengono rilevati tutti i colpi
  (con precisione al campione) e la griglia li segue battuta per battuta, cambi di tempo compresi; i
  vuoti senza click vengono riempiti al tempo locale; il "1" è il colpo accentato (più acuto o più forte);
- **nessuna traccia click**: si analizzano i transienti di una traccia ritmica (nomi come drum, batteria,
  perc, kick, loop, groove…, altrimenti la prima traccia Main) attorno al BPM del brano, ricavando il tempo
  esatto e dove cade la battuta 1 (l'attacco della traccia). Se le sezioni cambiano tempo si usa solo la
  prima sezione per trovare il "1".

Nella barra dell'Arrangement (e nel dettaglio del brano caricato) il menu **Griglia** mostra la traccia
usata, il BPM rilevato, dove cade il "1" e l'affidabilità; permette di scegliere un'altra traccia o
"Dati del brano" (griglia dal BPM inserito, da 0), di spostare il "1" di un movimento (◀ 1 / 1 ▶) e di
correggere di ±5 ms. Le scelte restano su questo computer; l'analisi viene salvata accanto al file
(`*.sync.json`) e non si ripete. Il count-in termina sempre sul "1": se l'audio ha già spazio prima, parte
dentro il brano, altrimenti l'app anticipa l'avvio.

### Griglia a mano (warp della griglia)

Il pulsante **Griglia a mano** dell'Arrangement (tasto **W**, solo per chi può modificare la scaletta) apre
una barra e rende la griglia modificabile. L'audio non viene toccato: è la griglia del click che si adatta.

- **Analisi da / a**: con la testina nel punto in cui inizia il ritmo utile (dopo un intro libero, per
  esempio) si preme *Analisi da*: tempo e "1" vengono calcolati da lì; *a* limita la fine. Le zone escluse
  appaiono scurite.
- **Ancoraggi**: si trascina una linea di battuta o di movimento sul colpo giusto. Tra due ancoraggi il tempo
  è costante e si ricalcola da solo, prima del primo e dopo l'ultimo prosegue il tempo vicino. Il primo
  trascinamento fissa la battuta 1 dove si trova (come il Time Warp di Cubase); **Ctrl** sposta tutta la
  griglia, **Shift** disattiva la calamita sui transienti della traccia di riferimento (segnati in fondo alla
  sua corsia), **doppio clic** fissa una linea dov'è, **Alt+clic** toglie un ancoraggio.
- **BPM** e **Tap**: tempo scritto a mano o battuto (almeno 3 colpi); fissano la battuta 1 dove si trova.
  Con due o più ancoraggi il tempo lo decidono gli ancoraggi.
- **Automatica** toglie ancoraggi e tempo manuale e torna all'analisi.

Intervallo di analisi, ancoraggi e tempo sono salvati sul brano (campo `grid`), quindi valgono su tutti i
computer della band; con gli ancoraggi le correzioni ◀ 1 / ±5 ms del menu Griglia non servono più.

### Gobbo (testo sincronizzato)

La vista **Gobbo** (terza vista, accanto a Session e Arrangement) mostra il testo del brano a slide,
sincronizzate a mano con la sequenza:

1. **Suddividi il testo**: “Genera dal testo” divide il campo *Testo gobbo* del brano (si scrive con la matita nel pannello *Testo del brano*, nella pagina Scaletta o sul web;
   se è vuoto, il testo degli accordi senza accordi) in slide di 2, 3, 4, 6 righe o a blocchi interi; i blocchi ripetuti (il ritornello) diventano **una sola
   slide** che compare più volte nella *Sequenza*. Le slide si possono anche creare dalla selezione del testo,
   rinominare, modificare, dividere al cursore, unire, riordinare.
2. **Registra i cambi**: carica il brano, premi **Registra** (R) e poi play. Durante la riproduzione clicca
   la slide (o i tasti **1–9**, **0** = schermo vuoto) nel momento del cambio, oppure **Invio / ↓** per la
   slide successiva della sequenza. Allo stop i cambi registrati sostituiscono quelli vecchi nel tratto
   suonato (punch in/out); **Ctrl+Z** annulla.
3. **Ritocca**: nella timeline in basso si trascinano i cambi; nella lista si spostano di ±50 ms o si cambia slide.
   Da fermo, cliccare una slide inserisce un cambio alla posizione della testina.

**Uscita gobbo** apre una seconda finestra per lo schermo dei cantanti (doppio clic: schermo intero), con
la slide successiva in piccolo e un *anticipo* regolabile. Slide e cambi sono salvati sul brano
(campo `prompter`), quindi valgono su tutti i computer; li modifica solo chi può modificare la scaletta.

**Gobbo su telefoni e tablet**: il computer con **Guida** attivo pubblica sulla scaletta (`live.prompter`) la
slide sullo schermo a ogni cambio, con l'anticipo impostato più 150 ms per la rete. Nell'app web il pulsante
**Gobbo** della scaletta la mostra a tutto schermo in sincrono; chi può guidare la band può anche cambiarla a
mano da lì (frecce, spazio, elenco delle slide), per esempio senza desktop. Disattivando *Guida* il gobbo in
rete si svuota.

Scorciatoie: **Spazio** play/stop (stop due volte = torna all'inizio), **← →** / Pagina su-giù brano
precedente/successivo (pedaliere Bluetooth), **↑ ↓** selezione, **Invio** avvia il selezionato,
**Tab** cambia vista (Session → Arrangement → Gobbo), **Home** inizio, **C** click.

## Da dove arrivano i dati

- Scalette e brani: Firestore, stesse query dell'app web (`setlists` di cui si è proprietari o membri).
- Media: dalla pagina della scaletta nell'app web (pulsante **Sequenze & Video**) o dalla pagina **Scaletta**
  del desktop (scheda **Sequenze & Video** del brano): gli stem e il video
  di ogni brano vanno su Firebase Storage (`setlists/{id}/items/{itemId}/…`) e sono descritti nei campi
  `stems[]` e `video` del brano. L'app desktop li scarica una volta in `<dati app>/media/` e li suona offline.
- Il **ruolo** di ogni stem (Main, Click, Guide/Cue, Solo monitor) sceglie l'uscita secondo la
  *matrice uscite* di questo computer (Impostazioni audio). Volume, mute e uscita si possono cambiare per
  singola traccia: restano salvati solo su questo computer.
- **Rehearsal**: ogni stem ha anche uno **strumento** (scheda Sequenze & Video). Nel dettaglio del brano la
  barra *Rehearsal* toglie dal mix un intero gruppo (Basso, Batteria…, Click compreso il metronomo, Guide)
  con un clic: vale per tutti i brani finché l'app resta aperta, senza toccare i mute salvati.
- *Segui palco*: carica il brano attivato dal master della band (Palco Sync dell'app web).
  *Guida*: il brano caricato qui diventa quello attivo per tutti (per proprietario, editor, palco).

Il codice condiviso con il web sta in `src/shared/` (copia di `setlists.js`, `media.js`, `music.js`). Dopo una
modifica nel repository web: `npm run sync-shared`. La configurazione Firebase invece non è nel repo: sta in
`desktop/.env` (copia `.env.example`, valori dalla console Firebase) e senza di essa la build si ferma.

## Requisiti

- Node.js ≥ 20, Rust stable (`rustup`).
- **Windows**: Visual Studio Build Tools con il carico "Sviluppo di applicazioni desktop C++" (MSVC + Windows SDK).
  WebView2 è già presente su Windows 10/11.
- **macOS**: Xcode Command Line Tools.
- **Linux** (Debian/Ubuntu): `sudo apt install libwebkit2gtk-4.1-dev libasound2-dev libssl-dev librsvg2-dev build-essential`
  e, per i video, i plugin GStreamer (`gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav`).

## Avvio

```bash
npm install
npm run app            # tauri dev: finestra dell'app con hot reload
npm run app:gnu        # idem con la toolchain Rust GNU (Windows senza MSVC; serve MinGW nel PATH)
npm run installer      # installer Windows della versione corrente (release/v<x.y.z>/)
cd src-tauri && cargo test   # test del motore (mappa tempo, resampler)
```

Con gli emulatori Firebase del repository web (`npm run emulators` in `../web`): `npm run app:emulators`
(accesso con email, password `password`).

## Installer e aggiornamenti (Windows)

L'installer è NSIS (`LiveTools_<versione>_x64-setup.exe`, installazione per tutto il computer) e installa
anche i prerequisiti:

- **WebView2**: se manca lo scarica e installa in silenzio il bootstrapper incluso;
- **Microsoft Visual C++ 2015-2022 Redistributable (x64)**: incluso nell'installer e installato solo se non
  c'è già (`src-tauri/windows/hooks.nsh`). Lo script lo scarica da Microsoft in `src-tauri/windows/redist/`
  (escluso da git) alla prima build.

Gli aggiornamenti sono le Release del repo **pubblico** [simcario/LiveTools-releases](https://github.com/simcario/LiveTools-releases)
(solo installer, il codice resta privato). L'app legge `releases/latest/download/latest.json`, verifica la firma
dell'installer e lo esegue in modalità passiva: l'app si chiude, si aggiorna e si riapre. All'avvio controlla
soltanto e segnala nella barra di stato; si installa da **Impostazioni › Aggiornamenti** (Ctrl+,), dove si
può anche disattivare il controllo automatico. Non installa mai niente da solo durante un live.

```bash
npm run installer                                   # solo installer della versione corrente
npm run release -- patch --notes "Cosa cambia"      # 0.1.0 → 0.1.1, build e pubblicazione
npm run release -- minor --notes-file note.md       # oppure major, oppure una versione esatta (1.2.0)
npm run release:publish                             # ripubblica l'installer già compilato
```

`release` aggiorna la versione in `package.json`, `tauri.conf.json` e `Cargo.toml`, compila con la toolchain GNU
(`LIVETOOLS_TOOLCHAIN` per cambiarla), firma, mette installer, `.sig` e `latest.json` in `release/v<x.y.z>/` e li
carica in una Release (prima in bozza, resa pubblica solo a caricamento finito). Le note compaiono nell'app.
Se la build fallisce dopo il cambio di versione, rilancia con la versione esatta (`npm run release -- 0.1.1`).

File fuori dal repo, in `%USERPROFILE%\.tauri\`:

- `livetools.key` / `livetools.key.pub`: chiave di firma degli aggiornamenti (la pubblica è in
  `plugins.updater.pubkey`). **Fanne un backup**: se si perde, le app installate non potranno più aggiornarsi
  e andranno reinstallate a mano. Password: variabile `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (ora vuota).
- `github-token`: token GitHub (fine-grained con *Contents: Read and write* sul repo delle release, oppure la
  variabile `GITHUB_TOKEN`). Se il repo non esiste lo script lo crea: in quel caso serve un token classico con `repo`.

## Login Google (una tantum)

Il login avviene nel browser di sistema (OAuth "app desktop" con PKCE e redirect su 127.0.0.1), poi
Firebase riceve l'ID token: stesso utente dell'app web.

1. Google Cloud Console del progetto Firebase → *APIs & Services → Credentials →
   Create credentials → OAuth client ID* → tipo **Desktop app**.
2. Fornisci id e secret all'app in uno dei due modi:
   - in fase di build: variabili d'ambiente `LIVETOOLS_GOOGLE_CLIENT_ID` e `LIVETOOLS_GOOGLE_CLIENT_SECRET`,
     oppure le stesse righe in un file `desktop/.env` (copia `.env.example`; è escluso da git e lo legge
     `src-tauri/build.rs`; le variabili d'ambiente reali hanno la precedenza);
   - oppure in un file `oauth.json` nella cartella di configurazione dell'app
     (Windows `%APPDATA%\it.lecaractere.livetools\`, macOS `~/Library/Application Support/it.lecaractere.livetools/`,
     Linux `~/.config/it.lecaractere.livetools/`):
     ```json
     { "clientId": "….apps.googleusercontent.com", "clientSecret": "…" }
     ```
   Per i client desktop Google non considera il secret confidenziale.

## Note e limiti di questa prima versione

- L'audio del video non viene riprodotto (il video è muto, la colonna sonora sta negli stem).
- Su Windows si usa WASAPI (condiviso). ASIO è dietro la feature Cargo `asio`, spenta di default:
  - per provarlo: `scoop install llvm`, poi `npm run app:asio` (al primo avvio scarica l'SDK Steinberg in
    `%USERPROFILE%\.asio_sdk`, fuori dal repo perché non è ridistribuibile);
  - per un installer: `LIVETOOLS_ASIO=1 npm run installer`. **Prima di pubblicarlo** serve una delle due licenze
    dell'SDK: l'accordo firmato da entrambe le parti (`Steinberg ASIO Licensing Agreement.pdf` nell'SDK, gratuito), oppure
    il rilascio dell'app sotto GPLv3. Un repo pubblico senza licenza non basta. Il nome o il logo ASIO seguono le
    *Usage Guidelines* con entrambe;
  - i driver a 24 bit impacchettati (`Int24`) non sono supportati da cpal 0.15: l'apertura dà errore.

  ASIO is a trademark of Steinberg Media Technologies GmbH, registered in Europe and other countries.
- Le uscite che la scheda non possiede ricadono su Out 1-2 (utile per provare sul portatile).
