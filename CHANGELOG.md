# Changelog

Tutte le versioni di LiveTools Desktop. Formato ispirato a [Keep a Changelog](https://keepachangelog.com/it/1.1.0/),
versioni [SemVer](https://semver.org/lang/it/). Procedura di rilascio: [docs/RELEASE.md](docs/RELEASE.md).

## [Non rilasciato]

## [0.1.29] — 2026-11-20

### Salvataggio chiesto solo a chiusura
- Cambiare brano non mostra più *Modifiche non salvate*. LiveTools chiede di salvare solo quando si cambia scaletta
  (Browser, Palco, telecomando: `chooseSetlist` in `App.jsx`) o si chiude la finestra principale (`onCloseRequested`,
  permesso `core:window:allow-destroy`), con l'elenco dei brani in bozza: *Salva tutto*, *Non salvare* / *Chiudi senza
  salvare*, *Annulla*.

### Telecomando: mixer completo
- Parte di stato `mixer` (lo stato di `lib/useMixer.js`, senza le curve di automazione) e comando `mixer {action}`, che
  passa le azioni al Mixer come la finestra F3 (non `window`/`play`). Sul mobile la schermata *Mixer completo*.

### Sezioni a brano fermo
- Un salto a una sezione a brano fermo (dal Palco o dal telecomando) metteva la testina un campione prima dell'inizio
  (arrotondamento al campione): computer e telecomando la contavano ancora nella sezione precedente, con battuta
  sbagliata (130.4 invece di 131.1) e Loop sulla sezione sbagliata. Tolleranza di un campione in `tempo.rs`
  (`ON_BEAT`, battuta e movimento) e in `sectionIndexAt` / `jumpTime` (`ON_START`); stesso calcolo nel telecomando.

## [0.1.28] — 2026-11-19

### Mute del Palco senza "Salva"
- Il mute dei gruppi dal Palco, dalla barra *Rehearsal* e dal telecomando resta su questo computer (`stageMute` nel mix
  locale, `lib/songMix.js` `trackMuted`/`setStageMute`/`clearStageMute`): non entra nella bozza del brano e non chiede
  di salvare. Arrangement, Mixer e Palco mostrano lo stesso stato; **M** di una traccia nell'Arrangement o nel Mixer
  toglie il mute del Palco da quella traccia e torna a quello del brano.

## [0.1.27] — 2026-11-19

### Mute coerente tra Arrangement e Palco
- Il nome di un gruppo nel mixer del Palco (e la barra *Rehearsal*) ora muta **tutte le tracce del gruppo**: è lo stesso
  mute di **M** nell'Arrangement e nel Mixer, salvato con il brano per chi può modificarlo, un solo passo di annulla
  (`setGroupMute`, `groupMute` in `lib/usePlayer.js`). Se solo alcune tracce del gruppo sono mutate il nome è rosso a
  metà e mostra quante (*1/3*); un tocco le muta tutte, il successivo le riattiva. Sparito il vecchio "fuori dal mix"
  di sessione (`leftOut`): il metronomo si spegne dalla sua striscia.

### Telecomando: i volumi
- Il telecomando riceve e muove il mixer del Palco: master, metronomo, pad e i gruppi (volume, mute, solo); comandi
  `master`, `clickGain`, `padGain`, `groupGain`, `groupMute` e parte di stato `mix` in `lib/remoteHost.js`.

### Più tracce selezionate e spostate insieme
- **Arrangement**: Ctrl+clic (nome della traccia o segmento) aggiunge o toglie dalla selezione, Maiusc+clic seleziona
  le tracce dall'ultima cliccata (o i segmenti in mezzo sulla stessa traccia). Con *Sposta* trascinando un segmento
  selezionato si muove tutta la selezione, un solo passo di annulla (`selectedToo`, `commitManyRegions`,
  `moveSegments` in `lib/arrange.js`).

### Avviso di griglia incerta
- Se l'analisi della griglia ha un'affidabilità sotto il 50% (brani senza traccia click: mix senza batteria, tempo
  che si muove) al caricamento compare *Griglia incerta* e il menu Griglia mostra *incerta: controllala*
  (`gridUnsure` in `lib/sync.js`). Le tracce click non sono toccate: lì i colpi sono trovati uno per uno.

### Pallini del metronomo nel fotogramma del battito
- Pallini e battuta.movimento (Trasporto e Palco) sono scritti direttamente nel fotogramma in cui cade il
  battito (`useBeatDisplay` in `lib/engine.js`): con un render React si accendevano un fotogramma dopo
  (misurato sul tablet: 28 ms dopo il click, ora in media 1,5 ms).
- Android: l'uscita si apre a 48 kHz, la frequenza nativa dei dispositivi: a 44,1 kHz Android rifiutava il
  percorso veloce e il suono usciva con circa 200 ms di ritardo (`best_config` in `audio/device.rs`).

### Cursori del mixer al tocco
- Su schermo touch il cursore (`Fader.jsx`) si muove solo trascinando il cappuccio (`.fader-grip`), in modo
  relativo; uno swipe sulla fessura scorre il mixer invece di spostare il cursore. Con il mouse nulla cambia.

### Pallini del metronomo, testina e griglia a tempo con il click
- I **pallini dei movimenti**, battuta.movimento, la **testina** e il passaggio sulle **linee della griglia** (Palco e
  Arrangement) seguono il suono che esce dalle casse: prima andavano avanti della latenza della scheda audio e
  scattavano a ogni aggiornamento (30 al secondo, in ritardo variabile). Il motore manda la posizione udita
  (`Shared::heard`, latenza da `OutputCallbackInfo`, su Android due buffer), il prossimo battito (`nextBeat`) e
  quanto è avanti il rendering (`ahead`, usato per programmare i salti); in JS `livePosition` è un orologio
  liscio agganciato agli aggiornamenti arrivati prima, `useLiveBeat` cambia i pallini nel fotogramma giusto.

### Torna all'inizio e barra di scorrimento dell'Arrangement
- **Arrangement**: pulsante **⏮ Inizio** (gruppo *Inizio*, sempre in barra): testina e vista all'inizio del brano,
  anche a brano in corso, come **Home**. Imparabile da un controller MIDI (`arrangement.start`).
- **Arrangement**: la barra di scorrimento orizzontale è fuori dallo scorrimento verticale delle tracce, sempre in
  fondo alla vista (`.arr-hscroll`, sincronizzata con la timeline): prima con il Dettaglio aperto finiva sotto il bordo.
- **Trasporto principale**: pulsante *Torna all’inizio* tra brano precedente e Play (`transport.start`).
- **Palco**: il pulsante ⏮ *Torna all'inizio* resta visibile anche nelle finestre strette (sotto i 900 px era nascosto).

### Gobbo: indicazioni colorate e parole a colori
- Vista **Gobbo**, sotto ogni slide: **+ Indicazione** aggiunge etichette colorate (Voce femminile, Finale… o
  personalizzate) mostrate sopra il testo, piccole anche sulla slide successiva (`slide.tags`, `SlideTags.jsx`).
- **Colora la selezione**: le parole selezionate diventano colorate o evidenziate (`[rosa]…[/]`,
  `[evid rosa]…[/]`, `slideLines` in `shared/prompter.js`). Finestra di uscita, NDI, anteprima, traccia
  Gobbo dell'Arrangement (senza segni), web e Leggio del mobile.

### Leggio del gobbo sui telefoni e tablet della band
- Con **Guida** e **Rete locale** accesi, lo stato della rete di palco porta anche il **gobbo** del brano caricato
  (slide e cambi, `prompterShare` in `lib/cues.js`): LiveTools Mobile lo mostra a tutto schermo nel *Leggio*, a tempo
  sul trasporto di chi guida. Lo stesso dal Telecomando (parte `prompter`). Il Leggio si collega a chi guida anche
  senza *Segui palco* (`useStageNetViewing`), senza caricare i brani.

### Telecomando dal telefono o dal tablet
- **Ctrl+, › Rete locale › Telecomando**: LiveTools Mobile comanda questo computer sulla stessa rete Wi-Fi (play/stop,
  brani e scaletta, sezioni, loop, fade, finestre Video e Gobbo, click, ottavi, count-in, avanzamento, pad, gruppi nel
  mix, vista). Codice di 4 cifre chiesto la prima volta; un codice sbagliato chiude la connessione. Avvisi quando un
  telecomando si collega o si scollega. Indipendente da Guida/Segui palco.
- `src-tauri/src/remote.rs` (solo std: TCP 47324 + beacon UDP 47323, JSON a righe), `lib/remote.js` (anche nel mobile),
  `lib/remoteHost.js` (stato pubblicato a parti: setlist, song, controls, transport 4 volte al secondo).

### Automazioni modificabili a mano, volume del click
- **Volume del click automatizzato**: con lo strumento Automazione la corsia *Click · Tempo* ha la sua curva del
  volume (`item.clickAuto.auto`), seguita dal motore colpo per colpo (`TempoFrames::click_gain`), dal tablet e
  dalla prova sul web; il count-in resta al suo volume. R spenta = il click suona al suo volume.
- **Linee modificabili**: si trascina la linea tra due punti per alzarla o abbassarla, **Alt+trascina** disegna la
  curva a mano, il triangolino rosso di un bordo del mute si trascina nel tempo (tracce e click).
- Clic destro su *Click · Tempo*: leggi / togli l'automazione del click.

### Menu del clic destro
- **Clic destro** su tessere e transizioni del Palco, sezioni e forma d'onda, clip, nomi delle tracce, sezioni, cue e
  cambi di tempo dell'Arrangement, canali del Mixer, brani e scalette del Browser, righe della pagina Scaletta: un menu
  con le azioni di quel punto (carica, tonalità e tempo, transizione, taglia, muta, elimina, rinomina, automazione,
  annulla, salva…). Frecce, Invio ed Esc nel menu; Spazio non fa partire la musica mentre è aperto. Elenco nel
  manuale, capitolo 2. Stesso componente sul tablet con il tocco lungo (`components/ContextMenu.jsx`).

### Driver ASIO® e licenza GPL
- **Driver ASIO** in tutti gli installer: in *Audio & uscite* le schede con driver ASIO compaiono nel gruppo
  **ASIO**. Gli aggiornamenti dall'app hanno ASIO anche loro (prima solo un installer personale).
- LiveTools Desktop è ora **software libero sotto GNU GPL v3 o successiva** (file `LICENSE`, mostrata anche
  dall'installer), con un permesso aggiuntivo per il NDI® Runtime e i componenti di Windows. L'SDK ASIO di
  Steinberg è usato con la sua licenza GPLv3 ed è nel repo (`src-tauri/vendor/asiosdk`): non si scarica più.
- Logo *ASIO Compatible* e nota sul marchio nella schermata di avvio, in *Audio & uscite* e nella nuova voce
  **Impostazioni › Aggiornamenti › Licenza e crediti** (licenza, link al codice sorgente).
- Le note di ogni versione pubblicata hanno il link al codice sorgente di quella versione.

ASIO is a registered trademark of Steinberg Media Technologies GmbH.

### Più leggero (benchmark del 2026-11-11)
- **Uscite NDI**: un'uscita accesa non comprime più 30 immagini Full HD al secondo quando nessuno la riceve
  (aspetta un ricevitore). Da fermo l'app passa da circa 16% a 1% di un core.
- **Stato del motore**: 30 aggiornamenti al secondo solo mentre qualcosa suona o si muove; da fermo solo quando
  cambia qualcosa (più uno ogni ~0,25 s per le finestre appena aperte).
- **Palco, Arrangement, Gobbo, Transizioni**: testina e parte suonata si muovono con trasformazioni grafiche (niente
  ricalcolo della pagina) e solo mentre il brano suona; i meter idem. Palco in riproduzione: da circa 65% a 30% di
  un core sul portatile di prova, sul tablet da 148% a 113%.
- **Schede audio a caldo**: l'elenco delle uscite si chiede di nuovo al sistema solo quando cambia l'elenco dei
  dispositivi (prima ~0,6 s ogni secondo sul thread che apre la scheda, con webcam e microfoni virtuali installati).
- Manuale e sito: requisiti minimi e consigliati di computer e tablet, con le misure.

### Computer di riserva
- **Impostazioni › Rete locale › Computer di riserva**: un secondo computer con *Segui palco* suona insieme a chi
  guida sulla rete di palco — stesso brano, play, stop e salti — e si riallinea da solo. Se il principale sparisce
  mentre suona, la riserva continua, avvisa e (se permesso) prende la *Guida* della band. Badge **RISERVA** su
  *Segui palco*.
- Chi guida manda in rete anche lo stato del trasporto (play, stop, posizione), una volta al secondo mentre suona.
- La riserva segue subito i salti di chi guida e impara da sola quanto ci mette a ripartire, così resta entro poche decine di millisecondi.

### Rete locale di palco: correzioni
- Se la finestra si ricarica mentre è collegata, ritrova subito chi guida (prima restava su *Cerco chi guida…*).
- Chi guida resta sulla stessa porta quando cambia nome, ruolo o scaletta: chi aveva scritto l'indirizzo a mano non lo perde più.
- "Collegato" solo quando chi guida risponde davvero, non appena si apre il collegamento.
- Lo stesso account su computer e tablet compare su due righe nell'elenco della band (*Tu, altro dispositivo*).

### Palco Sync: chi è collegato
- Pulsante con le persone nella barra *Band*: quanti della band hanno aperta la scaletta e, con un clic, l'elenco
  con ruolo, dispositivo, collegamento (rete di palco o internet) e ritardo; **Invia ping** per chi guida.
- Il computer ora compare nell'elenco *Palco Sync* dell'app web e risponde al ping di chi guida.
- Con *Segui palco* o *Guida* accesi, avviso quando qualcuno si scollega.

### Storico e analisi
- Pagina **Scaletta** › **Storico e analisi**, come sull'app web: modifiche, versioni da ripristinare (e *Salva
  versione ora*), ripartizione dei generi e durata stimata/effettiva del set.

### Cambi di metro nel brano
- Nella finestra di un cambio della corsia **Click · Tempo** c'è anche il **Metro**: da quella battuta il brano può
  passare per esempio da 4/4 a 6/8. Con i BPM vuoti cambia solo il metro. Click, count-in, griglia e cue seguono, sul
  computer, sul tablet e nel metronomo web; la bandierina mostra tempo e metro.

### Controllo pre-concerto
- **F7** (o il pulsante ✓ in alto a destra) apre il *Controllo pre-concerto*: un semaforo verde, giallo o rosso e
  una riga per ogni cosa che può mancare sul palco — file della scaletta scaricati, scheda audio scelta collegata e
  uscite di click/guide/pad/monitor esistenti, dropout, spazio su disco, uscite MIDI dei brani, pedale dello
  spartito, uscita video, modifiche non salvate, internet e rete di palco. Accanto a ogni problema il pulsante che lo
  risolve (*Scarica tutto*, *Audio & uscite*, *MIDI*, *Pedale*, *Apri uscita video*); si aggiorna da solo durante i
  download.

### Rete locale di palco
- Computer e tablet della band sulla stessa rete Wi-Fi si passano il brano direttamente, anche senza internet:
  chi ha **Guida** lo annuncia in rete, chi ha **Segui palco** lo trova da solo e carica subito il brano.
- Badge **LAN** su Segui palco e su Guida, con chi è collegato e il ritardo; **Impostazioni › Rete locale** con
  l'elenco della band, il ruolo sul palco e l'indirizzo di chi guida da scrivere a mano se il router blocca la ricerca.

### MIDI
- Il programma manda da solo le patch MIDI dei brani: quando un brano diventa quello nel player (caricato, scelto nel
  Palco o preso da una transizione) partono Bank Select e Program Change, finora inviati solo dall'app web. Lo stesso
  brano ricaricato non le rimanda.
- Nella scheda **MIDI** del brano anche **Control Change** (`7=100, 91=40`) e **SysEx** in esadecimale, con l'errore
  scritto sotto la riga se un valore non va bene.
- **MIDI learn** (Ctrl+M o il pulsante con la nota): si clicca un controllo (play, brani, sezioni, loop, fade,
  pad, click, viste, fader del mixer) e si preme un tasto o si muove un fader del controller. Le assegnazioni e gli
  ingressi ascoltati sono in Impostazioni › MIDI.
- Nuova sezione **Impostazioni › MIDI**: uscita (anche rtpMIDI), cambio patch automatico, uscita diversa per ogni
  strumento oppure *Non inviare da questo computer*, pulsante **Invia ora**.

### Scheda audio
- Nella finestra della scheda audio la casella **Rileva le schede audio collegate e scollegate** accende o spegne
  avvisi e cambi automatici di scheda.
- Collegando una scheda audio a programma aperto si apre **Audio & uscite** con l'avviso *Nuova scheda audio collegata* e il pulsante **Usa questa scheda**.
- Se la scheda in uso si scollega il brano si ferma e l'audio passa da solo all'uscita predefinita di sistema; prima il programma smetteva di rispondere.

### Piani e account
- Niente più attesa di abilitazione: chi entra con Google usa subito l'app con il piano Free.
- **Impostazioni › Account**: piano in corso (Free, Plus, Pro) con scadenza, brani della libreria rispetto al limite
  e, nel Pro, spazio usato nel cloud; barra gialla all'80% e rossa al limite.
- Con i limiti attivi l'app avvisa prima di scrivere: oltre i 10 brani del Free non se ne creano di nuovi, e tracce,
  video e Mixdown delle cue vanno nel cloud solo con il Pro del proprietario del brano (entro 25 GB). Gli spartiti
  fino a 20 MB restano per tutti. I rifiuti del server ora indicano di controllare ruolo e piano.
- Abbonamento dal computer: in **Impostazioni › Account** i pulsanti Plus e Pro aprono nel browser il pagamento
  (Stripe) di LiveTools web; con un abbonamento attivo, **Gestisci abbonamento e fatture**. Mostra da dove arriva
  il piano e la data di rinnovo o di fine.
- **Google Drive (Plus)**: tracce, video e Mixdown delle cue vanno sul Google Drive scelto dall'utente (qualsiasi
  account Google, collegato dalla pagina Account del web) e si scaricano da lì come gli altri file.

### Mixdown della traccia cue
- Pulsante **Mixdown** nella traccia cue: le cue diventano la traccia audio "Cues", visibile nell'Arrangement come
  le altre tracce e ascoltabile anche dal web.
- Finito il mixdown la traccia cue si muta per tutta la band e la traccia audio è attiva. Il muto della traccia cue
  (M nell'intestazione e nel Mixer) è salvato con il brano e vale su tutti i computer e sul web.

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
- Un brano senza sezioni non mostra più l’avviso sulla forma d’onda.
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
