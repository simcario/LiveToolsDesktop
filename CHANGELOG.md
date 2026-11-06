# Changelog

Tutte le versioni di LiveTools Desktop. Formato ispirato a [Keep a Changelog](https://keepachangelog.com/it/1.1.0/),
versioni [SemVer](https://semver.org/lang/it/). Procedura di rilascio: [docs/RELEASE.md](docs/RELEASE.md).

## [Non rilasciato]

### Fader da mixer
- I fader della vista Palco hanno un cappuccio rigato con la linea nel colore della striscia (bianco per il master) e una scala in dB da +6 a ∞ accanto alla guida.

### Uscite NDI
- **Video e gobbo in rete come sorgenti NDI®** (Impostazioni › Uscite NDI), anche con le finestre di uscita chiuse:
  il video a tempo con l'audio, il gobbo a 1920×1080 come nella finestra Gobbo.
- Nomi delle sorgenti personalizzabili; di default *LiveTools - Video* e *LiveTools - Gobbo* (il nome del
  computer lo aggiunge NDI davanti).
- L'installer installa **NDI 6 Runtime** se manca; senza runtime LiveTools funziona come prima e le Impostazioni
  lo segnalano.

### Spartito PDF
- Spartito PDF del brano (scheda *Sequenze, Video & PDF*), scaricato in cache come stem e video.
- Vista **Spartito** nella pagina Live: una o due pagine affiancate, schermo intero, pagine girate con pedale
  Bluetooth, tastiera o clic.
- Pedale collegato mostrato nella vista; **Impostazioni › Pedale & spartito** con elenco dei dispositivi
  Bluetooth collegati, prova del pedale e apprendimento dei tasti.

### Vista Palco
- La griglia **Session** è sostituita dalla vista **Palco**, per suonare dal vivo: comandi grandi, panoramica del brano,
  sezioni, mixer del brano caricato e scaletta nella stessa schermata. Toccare la scaletta non interrompe il brano in
  corso.
- **Disposizione come Playback** di MultiTracks, con i colori dell'app: trasporto in alto, scaletta a tessere con
  l'indicatore dell'auto-avanzamento, sezioni come etichette sulla forma d'onda (con il loop su quella in corso) e
  mixer con console *Loop* / *Loop ∞* / *Annulla*. Nel mixer si toglie un gruppo dal mix toccandone il nome.
- **Zoom e griglia** sulla forma d'onda: zoom fino a ×32 con la testina seguita a brano in corso, griglia che si mostra
  o nasconde, con numeri di battuta e risoluzione da 8 battute a un movimento.
- **Salto alle sezioni** sul prossimo movimento, sulla prossima battuta o a fine sezione, e **loop della sezione**:
  avvengono senza interruzioni e restano a tempo con il click. Loop di una volta o infinito. Tasti 1-9, L ed Esc.
- **Sezioni create sulla forma d'onda** come marker agganciati alle battute: si aggiungono alla testina con il pulsante **+**
  (il tocco sulla forma d'onda sposta solo la testina), si spostano, rinominano ed eliminano nella vista Palco e si
  salvano con *Salva*. Ogni sezione ha un colore diverso. Griglia e cue già create non cambiano.
- **Fade delle tracce** (F): le tracce sfumano nel tempo scelto in Impostazioni, click e pad restano.
- **Pad** (P): pad d'ambiente generato nel motore, anche a brano fermo, sulla sua uscita della matrice. Segue la
  tonalità del brano o una scelta a mano, cambia tonalità con una dissolvenza, può accendersi da solo al play.
- **Transizioni tra brani** come in Playback, scelte toccando il cerchio tra due tessere e condivise con la band:
  *Prepara il prossimo*, *Resta nel brano*, *AutoLink*, *Sovrapponi*, *Dissolvenza*. Il brano successivo viene
  preparato in anticipo e il motore lo fa partire sul campione esatto, senza buchi.
- **Tonalità e tempo** di un brano nella scaletta (±6 semitoni, ±20 BPM): le tracce si rielaborano offline con
  Signalsmith Stretch (MIT) e restano in cache accanto ai file. Click, guide e cue cambiano solo il tempo. Griglia,
  sezioni, cue e video restano allineati.

- Le battute della griglia del brano caricato si salvano con la scaletta (`beatMap`), per il nuovo **Player palco** del
  web: i suoi salti cadono sulle stesse battute del desktop. Si scrivono solo se cambiano e se puoi modificare la scaletta.

### Traccia cue
- Un quadratino messo sulla battuta sbagliata si trascina con la freccia sul quadratino giusto; un clic apre ancora il
  menu.

### Arrangement
- **Corsia delle sezioni** come la Marker Track di Cubase: clic per andarci (anche a brano in corso), trascinamento
  dell'inizio, doppio clic per rinominare, Ctrl+clic o Ins per aggiungere.
- Tab **Sezioni** nel Browser con l'elenco delle sezioni del brano.

### Barre e pannelli
- Barre di comandi divise in gruppi per categoria: quando sono piene vanno a capo su una nuova riga.
- Barre personalizzabili: gruppi nascosti, ordine, nuove righe, nomi delle categorie.
- Browser e Dettaglio con i pannelli in tab, come in Cubase, oppure affiancati.

### Player
- Al primo caricamento di un brano, barra di download con percentuale nella barra in alto.

### Interfaccia
- Browser, Dettaglio e ispettore si ridimensionano trascinando il bordo e si chiudono dalla Control bar o con
  Ctrl+Alt+L / E / R.
- Tracce del brano e scaletta si riordinano solo trascinando la maniglia: tolti i pulsanti su/giù.
- Riquadro *Brano in caricamento* al centro dello schermo finché il brano non è pronto: percentuale durante il
  download, barra animata durante la preparazione. L'app resta utilizzabile.

### Audio
- Driver ASIO selezionabili in *Audio & uscite*, solo nelle build con la feature `asio` (non ancora negli
  installer pubblicati, vedi README).

### Corretto
- *Importa dalle scalette* copiava tracce, video e spartito ma non cue e posizioni delle tracce: nei brani importati
  sparivano la traccia cue e gli spostamenti, e con loro la numerazione delle misure dei brani allineati a mano. Ora
  vengono copiati; i brani già importati li ritrovano da soli dall'elemento della scaletta, dove erano rimasti.
- Arrangement: con lo strumento **Sposta**, afferrare una clip vicino a un bordo la accorciava invece di
  spostarla: compariva spazio vuoto all'inizio e l'audio restava fuori griglia. Ora Sposta muove sempre la clip
  intera; i bordi si accorciano solo con **Selezione**.
- Traccia cue: con la battuta 1 a inizio brano il primo quadratino mancava (la griglia partiva da 1.2), la cue lì
  sopra non si sentiva e la traccia non si poteva riportare su 1.1.
- Traccia cue: con lo strumento **Sposta** un clic apriva il menu di inserimento invece di spostare. Ora la mano
  sposta soltanto; le cue si inseriscono con gli altri strumenti.
- Arrangement: spostando o accorciando tutte le tracce restava un vuoto all'inizio del brano. Ora il brano parte dal
  suo primo audio o dalla battuta 1, se viene prima, così un conteggio parlato prima dell'audio resta intero e
  spostabile; altre battute vuote iniziali restano solo se inserite con *Aggiungi → Battute…*. I brani già salvati
  con un vuoto vengono corretti all'apertura nell'Arrangement, come modifica da salvare.
- Eliminazione di tracce, sequenze, video, spartiti e brani: il file viene cancellato prima dallo storage cloud e
  solo dopo tolto dall'elenco. Se lo storage rifiuta l'operazione compare un errore e l'elemento resta in elenco,
  così si può riprovare; prima il file restava nel cloud senza più riferimenti. La conferma dice cosa succede ai
  file, compresi quelli di una scaletta duplicata che restano all'originale.

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
