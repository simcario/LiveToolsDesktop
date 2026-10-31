# Changelog

Tutte le versioni di LiveTools Desktop. Formato ispirato a [Keep a Changelog](https://keepachangelog.com/it/1.1.0/),
versioni [SemVer](https://semver.org/lang/it/). Procedura di rilascio: [docs/RELEASE.md](docs/RELEASE.md).

## [Non rilasciato]

### Spartito PDF
- Spartito PDF del brano (scheda *Sequenze, Video & PDF*), scaricato in cache come stem e video.
- Vista **Spartito** nella pagina Live: una o due pagine affiancate, schermo intero, pagine girate con pedale
  Bluetooth, tastiera o clic.
- Pedale collegato mostrato nella vista; **Impostazioni › Pedale & spartito** con elenco dei dispositivi
  Bluetooth collegati, prova del pedale e apprendimento dei tasti.

### Player
- Al primo caricamento di un brano, barra di download con percentuale nella barra in alto.

### Interfaccia
- Browser, Dettaglio e ispettore si ridimensionano trascinando il bordo e si chiudono dalla Control bar o con
  Ctrl+Alt+L / E / R.
- Tracce del brano e scaletta si riordinano solo trascinando la maniglia: tolti i pulsanti su/giù.

### Audio
- Driver ASIO selezionabili in *Audio & uscite*, solo nelle build con la feature `asio` (non ancora negli
  installer pubblicati, vedi README).

### Corretto
- Arrangement: con lo strumento **Sposta**, afferrare una clip vicino a un bordo la accorciava invece di
  spostarla: compariva spazio vuoto all'inizio e l'audio restava fuori griglia. Ora Sposta muove sempre la clip
  intera; i bordi si accorciano solo con **Selezione**.

## [0.1.0] — 2026-10-28

Prima versione distribuita con installer e aggiornamenti automatici.

### Player
- Motore audio nativo in Rust (cpal + Symphonia): wav, aiff, flac, mp3, ogg, m4a/aac, alac in streaming da
  disco, resampling, mix sample-accurate, mute/solo/volume/pan.
- Routing per ruolo dello stem (Main, Click, Guide/Cue, Solo monitor) su uscite multicanale con matrice
  uscite per computer.
- Click generato dal motore con count-in e cambi di tempo/metro per sezione; suoni sintetizzati (Beep,
  Woodblock, Cowbell, Stick, HiHat) con volume e intonazione per accento, movimento, suddivisione e count-in.
- Precount per brano dall'Arrangement.
- Video sincronizzato all'audio, in anteprima e su seconda finestra per proiettore.
- Viste Session (griglia scene/tracce con mixer), Arrangement (timeline) e Gobbo.
- Rehearsal: esclusione al volo di gruppi di strumenti.
- Palco Sync: *Segui palco* e *Guida* con l'app web.
- Download dell'intera scaletta per l'uso offline; cartella media spostabile.

### Griglia
- Allineamento automatico di click, count-in e righello alla traccia click o a una traccia ritmica.
- Menu Griglia (traccia di riferimento, spostamento del "1", ±5 ms).
- Griglia a mano: intervallo di analisi, ancoraggi, BPM e Tap, salvata sul brano.

### Arrangement
- Strumenti stile Cubase (selezione, sposta, taglia, muta, elimina; tasti 1–5) sui segmenti degli stem, senza
  riscrivere i file audio.
- Aggiungi → Battute: inserimento di battute alla testina con spostamento di stem, cue, griglia, gobbo e
  sezioni.
- Annulla / ripeti (Ctrl+Z / Ctrl+Shift+Z).
- Traccia cue: guide vocali parlate (89 clip incluse) su griglia a quarti/ottavi, come traccia live o
  renderizzata in uno stem "Cues" usabile anche dal web.

### Gobbo
- Slide dal testo del brano, ritornelli come slide unica ripetuta, registrazione dei cambi durante la
  riproduzione (punch in/out), ritocco nella timeline.
- Uscita gobbo su seconda finestra e su telefoni/tablet tramite l'app web.

### Scaletta e brani
- Pagina Scaletta: modifica di brani e blocchi, ispettore con Brano, Palco, Spartito, Testo gobbo,
  Sequenze & Video, MIDI, Colonne.
- Pagina Brani: libreria dei brani condivisa tra scalette, importazione dalle scalette esistenti,
  eliminazione con i relativi file.
- Caricamento di stem e video dal desktop, con copia immediata nella cache locale.

### Installazione
- Installer NSIS per Windows x64 con WebView2 e Visual C++ Redistributable.
- Aggiornamenti firmati da GitHub Releases, segnalati all'avvio e installati da Impostazioni › Aggiornamenti.
- Impostazioni stile VS Code (Ctrl+,) con ricerca: Generale, Trasporto, Aggiornamenti.

### Limiti noti
- L'audio del video non viene riprodotto (la colonna sonora sta negli stem).
- Windows: solo WASAPI condiviso, ASIO non ancora disponibile.
- Il video non segue i tagli dell'Arrangement (si sposta solo se il taglio è prima del suo inizio).
- Installer disponibile solo per Windows.

[Non rilasciato]: https://github.com/simcario/LiveTools-releases/releases
[0.1.0]: https://github.com/simcario/LiveTools-releases/releases/tag/v0.1.0
