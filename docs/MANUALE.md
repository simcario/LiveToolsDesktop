# LiveTools Desktop — Manuale d'uso

LiveTools Desktop suona le scalette di LiveTools dal vivo: **sequenze multitraccia (stem), click, video e
gobbo**, sincronizzati tra loro e con il resto della band. Usa lo stesso account Google e gli stessi dati
dell'app web: una scaletta creata sul web si apre qui, e viceversa. Guide, novità e download sono sul sito
[livetoolsdaw.com](https://livetoolsdaw.com), che si apre anche dal link in fondo a Impostazioni e a questo manuale.

> Questo manuale è per chi usa l'app (musicisti, direttore musicale, tecnico). Per compilare l'app e
> pubblicare le versioni vedi [README](../README.md) e [RELEASE.md](RELEASE.md).

---

## 1. Installazione e primo avvio

1. Scarica `LiveTools_<versione>_x64-setup.exe` dall'ultima release:
   <https://github.com/simcario/LiveTools-releases/releases/latest>.
2. Avvia l'installer (installa per tutto il computer, servono i permessi di amministratore). Se mancano,
   installa da solo **WebView2**, **Visual C++ Redistributable** e **NDI 6 Runtime** (per le uscite NDI), se mancano.
3. Apri **LiveTools** e accedi con Google: il login si apre nel browser, poi torna all'app.
4. Puoi usare l'app subito, con il piano Free. Le scalette condivise con te (anche tramite link di invito)
   si aprono con tutto il loro materiale, anche se appartengono a un account a pagamento.

La schermata di avvio elenca in basso il software di terze parti usato dall'app (framework, plugin Tauri,
librerie audio e video, font).

### Account e piano

**Impostazioni › Account** mostra il piano (Free, Plus o Pro), i brani della tua libreria rispetto al limite
del piano e, nel Pro, lo spazio occupato nel cloud LiveTools. La barra diventa gialla all'80% e rossa al
limite.

Per abbonarti premi **Plus** o **Pro** nella stessa sezione (Plus 4,99 €/mese o 39,99 €/anno, prova di 7
giorni; Pro 9,99 €/mese o 89,99 €/anno, prova di 14 giorni): si apre nel browser la pagina *Account e
abbonamento* di LiveTools web, dove paghi con Stripe. Entra con lo stesso account Google dell'app. Dopo il
pagamento il piano compare qui da solo, entro pochi secondi. Con un abbonamento attivo il pulsante diventa
**Gestisci abbonamento e fatture**. Se hai comprato dall'app Android, lo gestisci dal Play Store.

Con il **Plus** tracce e video dei tuoi brani vanno sul tuo **Google Drive**. In *Impostazioni › Account* premi
**Collega Google Drive**: si apre la pagina Account del web, dove scegli l'account Google (anche diverso da quello
dell'app). Da lì in poi i caricamenti e il Mixdown delle cue vanno su quel Drive, cartella *LiveTools*, e l'app li
scarica da lì come gli altri file. Un brano con i file sul tuo Drive si sente solo dai tuoi dispositivi.

**Piano Free: un solo dispositivo.** Con il Free l'account funziona su un solo dispositivo, quello con cui hai
cominciato (il computer, il browser o il tablet). Tracce e video restano solo lì (nella cartella dei media) e non vanno online. Da un
altro dispositivo l'app mostra *Account in uso su un altro dispositivo* e non si usa: se hai cominciato dal
computer, con lo stesso account non entri dal browser né dal tablet. Con Plus o Pro lo usi ovunque. Se cambi
computer, l'amministratore può spostare l'account sul nuovo (i file salvati solo sul vecchio restano lì).

**File audio in MP3.** Nel cloud LiveTools i file WAV, AIFF e FLAC (anche il Mixdown delle cue) vanno sempre in
**MP3 a 320 kbps**: li converte il computer prima di caricarli (la riga del caricamento dice *conversione in
MP3*; un brano di 5 minuti richiede circa mezzo minuto), il file originale resta sul disco e il brano occupa
circa un quinto. Le tracce restano allineate al campione con il click e tra loro. MP3, M4A e Ogg si caricano
come sono. Con il **Plus**, in *Impostazioni › Account* sotto Google Drive, scegli se convertirli anche per il
Drive (*Converti in MP3*, la scelta iniziale) o caricarli così come sono.

Quando l'amministratore attiva i limiti dei piani, l'app te lo dice prima di provarci:

- con il **Free**, oltre i 10 brani nella libreria non puoi crearne di nuovi (né dalla pagina **Brani** né
  aggiungendo un brano nuovo a una scaletta); puoi sempre aggiungere alle scalette i brani che hai già. Un
  brano nuovo creato nella scaletta di un altro (di cui sei editor) va nella libreria del proprietario della
  scaletta e conta nel suo piano;
- **tracce audio, video e Mixdown delle cue** vanno nel cloud solo se il proprietario del brano ha il **Pro**,
  entro i suoi 25 GB. Su un brano condiviso conta il piano del proprietario, non il tuo;
- **spartiti PDF e immagini** fino a 20 MB si caricano con tutti i piani.

### Aggiornamenti

All'avvio l'app controlla se c'è una nuova versione e la segnala nella **barra di stato**. Non installa mai
niente da sola: per aggiornare apri **Impostazioni › Aggiornamenti** (Ctrl+,) e premi *Installa la x.y.z e riavvia*. L'app si
chiude, si aggiorna e si riapre. Non aggiornare a ridosso di un concerto.

---

## 2. L'interfaccia

| Area | Cosa contiene |
|---|---|
| **Control bar** (in alto) | ⏮ ▶ ■ ⏭, posizione battuta.movimento e tempo, BPM / metro / tonalità, count-in, click, auto-avanzamento, *Segui palco* / *Guida*, scheda audio, impostazioni |
| **Browser** (sinistra) | tab *Brani*, *Scalette* e, nella vista Arrangement, *Sezioni*; stato dei media offline, icona dello spartito (PDF, link o accordi), *Scarica tutta la scaletta* |
| **Vista centrale** | **Palco**, **Arrangement**, **Gobbo** o **Spartito** (Tab per cambiare) |
| **Dettaglio** (sotto) | tab *Brano*, *Tracce*, *Video* e (dalla prossima versione) *Mixer*: dati del brano, stato dei download, barra *Rehearsal*, anteprima video, volumi delle tracce |
| **Barra di stato** | pagine **Live** (Ctrl+1), **Scaletta** (Ctrl+2), **Brani** (Ctrl+3); avviso aggiornamenti |

I pannelli intorno alla vista centrale (Browser, Dettaglio e, nelle pagine Scaletta e Brani, l'ispettore) si
chiudono e riaprono con i pulsanti nella Control bar o con **Ctrl+Alt+L / E / R**. Si ridimensionano trascinandone
il bordo; doppio clic sul bordo per tornare alla misura iniziale. Misure e stato restano su questo computer. La
vista **Palco** occupa tutta la finestra: non ha Browser né Dettaglio.

Dalla prossima versione:

- **Tab nei pannelli.** Browser e Dettaglio raggruppano i loro pannelli in tab, come in Cubase. Il pulsante accanto alle tab
  (o nell'intestazione, se sono affiancati) passa dalle tab ai pannelli affiancati e viceversa.
- **Barre di comandi.** La barra principale e quelle di Palco, Arrangement, Gobbo, Spartito, Scaletta e Brani sono divise in gruppi per categoria
  (Trasporto, Tempo, Griglia, Vista…). Quando lo spazio finisce un gruppo va a capo intero, su una nuova riga: nessun
  comando resta fuori schermo. Manuale, Impostazioni e il tuo avatar restano sempre nell'angolo in alto a destra della barra
  principale, comunque vadano a capo gli altri gruppi.
- **Personalizzare una barra.** Con il pulsante a cursori in fondo alla barra, o con un clic destro su di essa, puoi nascondere
  un gruppo, cambiarne l'ordine trascinando la maniglia e farlo partire da una *Nuova riga*. *Ripristina* torna alla
  disposizione iniziale. Puoi anche mostrare i nomi delle categorie sopra i gruppi. I gruppi indispensabili, come il Trasporto,
  non si possono nascondere. Le scelte restano su questo computer.

### Pagine

- **Live** — il player: Palco, Arrangement, Gobbo, Spartito.
- **Scaletta** — modifica della scaletta (stessi dati del web).
- **Brani** — la libreria dei brani riutilizzabili tra più scalette.

---

## 3. Preparare una serata

### 3.1 Scaletta

Nella pagina **Scaletta**:

- scrivi il titolo in fondo all'elenco e premi Invio per aggiungere un brano; aggiungi blocchi *pausa*,
  *discorso*, *separatore*;
- riordina trascinando la maniglia; elimina con la ×;
- a destra l'**ispettore** del brano selezionato: schede *Brano*, *Palco*, *Spartito*, *Testo gobbo*,
  *Sequenze & Video*, *MIDI*, *Colonne*. Salva con **Ctrl+S** (salva anche da solo quando cambi brano o
  pagina). Sotto il titolo di ogni brano un tag indica se ha lo spartito e in che forma (*Spartito · PDF + link + accordi*, o *immagine* per una foto), oltre a *Testo* e *Gobbo*.

Ogni modifica finisce nello storico della scaletta. Colonne personalizzate e condivisione si gestiscono
dall'app web.

### 3.2 Libreria brani

Nella pagina **Brani** ogni brano esiste una volta sola e può comparire in più scalette: stem, video, cue e
gobbo appartengono al brano della libreria, quindi una correzione vale ovunque.

- *Importa dalle scalette* porta nella libreria i brani già presenti nelle tue scalette (raggruppa i doppioni
  per titolo, artista e file), con tracce, video, spartito, cue e posizioni delle tracce.
- Eliminare un brano dalla libreria cancella anche le sue tracce e il suo video. Togliere un brano da una
  scaletta, invece, non cancella i file.

### 3.3 Tracce e video

Scheda **Sequenze & Video** del brano (o dal web, *Sequenze & Video*): trascina i file sulla scheda o usa il
pulsante. Per ogni stem scegli:

- **Ruolo** — decide l'uscita della scheda audio: *Main*, *Click*, *Guide/Cue*, *Solo monitor*;
- **Strumento** — Batteria, Basso, Chitarre, Tastiere, Voce, Cori… (serve al Rehearsal);
- nome e mute di default; l'ordine si cambia trascinando la maniglia.

Se le righe sono strette, allarga l'ispettore trascinandone il bordo.

Eliminare una traccia, l'intera sequenza, il video o lo spartito chiede sempre conferma e cancella il file
anche dallo storage cloud, per tutta la band. Fanno eccezione i file di una scaletta duplicata, che
appartengono all'originale e restano nello storage. La copia già scaricata su questo computer resta nella
cartella media.

Per il video: un file per brano, con **offset** rispetto all'audio. Formati audio letti: wav, aiff, flac,
mp3, ogg, m4a/aac, alac. Il video è muto (la colonna sonora sta negli stem).

**Elementi solo video** (dalla prossima versione). Un elemento della scaletta può essere solo un video, per esempio il
video d'ingresso: nella scheda del brano scegli il tipo di esecuzione **Video** e carica il video, senza stem. Qui si
sente il **suono del video** (gruppo *Video* nel mixer del Palco) e, di serie, a fine video parte subito il brano dopo
(*AutoLink*, vedi *Transizioni*). Per i dettagli vedi *Video in scaletta* nel capitolo 10.

I caricamenti continuano anche se cambi brano o pagina, e ogni file caricato è già nella cache locale.

### 3.4 Scaricare per l'offline

Prima del concerto, nel Browser premi **Scarica tutta la scaletta**: i media finiscono nella cartella media
del computer e l'app suona senza rete. Lo stato di ogni brano è visibile accanto al titolo.

Se carichi un brano che non è ancora sul computer, l'app lo scarica in quel momento: nella barra in alto compare
una barra di avanzamento con la percentuale, che sparisce appena il brano è pronto. Dalla prossima versione, finché
il brano non è pronto, al centro dello schermo compare anche un riquadro *Brano in caricamento*, con la percentuale
durante il download e una barra animata durante la preparazione. Non blocca l'app: puoi fermare o scegliere un altro
brano.

La cartella media si cambia da **Impostazioni › Generale › Posizione**: l'app sposta i file esistenti e si
ricarica.

---

## 4. Suonare

### 4.1 Trasporto e scorciatoie

| Tasto | Azione |
|---|---|
| **Spazio** | play / stop (stop due volte = torna all'inizio) |
| **← →**, Pagina su / giù | brano precedente / successivo (pedaliere Bluetooth); nella vista Spartito girano le pagine |
| **↑ ↓** | selezione nell'elenco |
| **Invio** | avvia il brano selezionato |
| **Tab** | Palco → Arrangement → Gobbo → Spartito |
| **1 … 9** | vista Palco: salta alla sezione con quel numero |
| **L** | vista Palco: loop della sezione in corso, o esce dal loop |
| **Esc** | vista Palco: annulla il salto in coda o esce dal loop |
| **F** | vista Palco: fade delle tracce (e di nuovo per riportarle dentro) |
| **P** | vista Palco: pad acceso / spento |
| **Ins** | Arrangement: nuova sezione alla battuta della testina |
| **Home** | inizio del brano |
| **C** | click acceso / spento |
| **Maiusc+C** | click in ottavi acceso / spento (dalla prossima versione) |
| **Ctrl+1 / 2 / 3** | pagina Live / Scaletta / Brani |
| **Ctrl+Alt+L / E / R** | apre o chiude Browser / Dettaglio / ispettore |
| **F3** | mixer del brano in una finestra separata, e di nuovo per chiuderla (dalla prossima versione) |
| **F4** | uscita video accesa / spenta (dalla prossima versione) |
| **F6** | uscita gobbo accesa / spenta (dalla prossima versione) |
| **Ctrl+,** | Impostazioni |
| **F1** | Questo manuale (anche dal pulsante **?** in alto) |

*Auto-avanzamento*: a fine brano prepara il successivo, se il brano non ha una transizione sua (vedi *Transizioni*
nella vista Palco).

### 4.2 Palco

Dalla prossima versione la vista **Palco** sostituisce la griglia Session: è pensata per suonare, si legge da
lontano e i comandi sono grandi anche per il touch. La disposizione è quella di Playback di MultiTracks, dall'alto in
basso:

- **Barra del trasporto**: metro e BPM, battuta con i movimenti, tempo trascorso e rimanente, ⏮ (torna all'inizio, a
  brano fermo), ▶/■ grande, **FADE**, **PAD**, titolo, tonalità e artista. A destra *Video* (uscita video del brano),
  *Modifica* (crea e sposta le sezioni) e il menu della scaletta.
- **Scaletta**: i brani in fila come tessere, con numero, tonalità, BPM e durata; quello caricato è evidenziato. Un clic
  seleziona una tessera, un **doppio clic** carica il brano (dalla prossima versione; prima bastava un clic). Mentre la
  musica suona il brano in corso continua: il doppio clic sugli altri non fa nulla. Dalla prossima versione una tessera con
  l'icona di download ha file non ancora su questo computer: al caricamento vengono scaricati e la tessera mostra la
  percentuale e una barra di avanzamento.
  Il cerchio tra due tessere è la **transizione** (vedi sotto). Il pulsante con i cursori in alto a destra di una
  tessera cambia **tonalità e tempo**. Attenzione: ⏮ ⏭ nella Control bar e i tasti **← →** cambiano brano subito,
  anche durante l'esecuzione.
- **Forma d'onda**: tutto il brano, con le sezioni come etichette colorate in alto (numero, nome, battute). Quella in
  corso è piena e ha a destra l'icona del loop. Tocca un punto della forma d'onda per andare alla linea della griglia più
  vicina, o alla battuta più vicina se la griglia è nascosta. Sopra leggi quante battute mancano alla sezione successiva.
  Un brano senza sezioni non ha salti né loop. Vedi *Zoom e griglia* più sotto.
- **Mixer**, in basso. A sinistra la console con *Loop*, *Loop ∞* e *Annulla*, poi master e metronomo e un fader per
  ogni gruppo di strumenti del brano caricato, gli stessi dei pulsanti *Rehearsal* (batteria, basso, tastiere, click,
  guide…). Il volume del gruppo si somma a quello delle sue tracce e resta salvato su questo computer per tutti i brani.
  Come in Playback, **tocca il nome** per togliere il gruppo dal mix (diventa rosso e barrato) o per spegnere il
  metronomo; **S** mette in solo tutte le tracce del gruppo. Accanto al metronomo c'è la striscia del **Pad**.
  I fader sono come quelli di un mixer: cappuccio rigato con la linea nel colore della striscia (bianco per il master)
  e scala in dB accanto alla guida, da +6 a ∞ (silenzio). Doppio clic su un fader per tornare al valore di partenza.

**Fade delle tracce.** *FADE* (**F**) sfuma le tracce del brano in corso; click e pad restano. L'anello del pulsante
si svuota mentre sfuma. Premilo di nuovo (*IN*) per riportarle dentro. La durata si sceglie in **Impostazioni →
Palco** (5 secondi se non la cambi). Stop o cambio brano riportano le tracce a pieno volume.

**Pad.** *PAD* (**P**) accende un pad d'ambiente generato dall'app, come l'Ambient Pad di Playback: suona anche a
brano fermo, sull'uscita *Pad* della matrice (Impostazioni audio) e con il master. Entra e esce in pochi secondi.
Nel mixer, il menu della striscia sceglie la tonalità:

- *Brano*: segue la tonalità del brano caricato (cambio di tonalità compreso). Quando cambia brano il pad passa alla
  nuova tonalità con una dissolvenza, così può fare da tappeto tra un brano e l'altro.
- una tonalità precisa (*C*, *Db*, …): resta quella, qualunque brano carichi.

Il nome *Pad* accende e spegne, il fader ne regola il volume. Con **Impostazioni → Palco → Accendi il pad quando parte
un brano** il pad si accende da solo al play. Se il brano non ha una tonalità, scegline una nel menu.

**Transizioni.** Come in Playback, il cerchio tra due tessere dice cosa succede alla fine del brano. Toccalo (serve
poter modificare la scaletta) e scegli; la scelta vale per tutta la band:

- ⏭ *Prepara il prossimo*: a fine brano carica il successivo senza farlo partire.
- ■ *Resta nel brano*: a fine brano resta caricato questo.
- ▶ *AutoLink*: il successivo parte appena finisce questo, senza buchi.
- *Sovrapponi*: il successivo parte a pieno volume sull'ultima parte di questo, la più corta tra l'ultima sezione,
  la prima sezione del successivo e 5 secondi. Questo prosegue fino alla sua fine.
- *Dissolvenza*: negli ultimi 5 secondi questo sfuma mentre il successivo entra.
- *Come l'auto-avanzamento*: la scelta predefinita. Segue l'opzione *Auto-avanzamento* di questo computer
  (prepara il prossimo se è accesa, resta nel brano se è spenta). Per un elemento *Video* la scelta predefinita è
  invece *AutoLink* (dalla prossima versione).

Con *AutoLink*, *Sovrapponi* e *Dissolvenza* il brano successivo viene preparato appena carichi quello prima. Quando il
cerchio diventa pieno, l'app è pronta a fare la transizione. Il successivo parte dall'inizio, senza count-in. Se non
si riesce a prepararlo (per esempio perché è offline e non è scaricato), a fine brano viene solo caricato.

**Tonalità e tempo.** Il pulsante con i cursori di una tessera cambia la tonalità (fino a 6 semitoni sopra o sotto) e il
tempo (fino a 20 BPM in più o in meno, se il brano ha un BPM) del brano in questa scaletta, come in Playback. Le tracce si
rielaborano una volta su ogni computer, alla prima apertura. Mentre l'app lavora la barra in basso mostra quante ne ha
fatte, e il risultato resta salvato accanto ai file. Click, guide e cue cambiano solo il tempo, non la tonalità.
Griglia, sezioni, cue, gobbo e video restano allineati: tutto segue il nuovo tempo. *Originale* toglie le modifiche.
Sulle tessere un BPM con l'asterisco è cambiato, una tonalità bordata di viola è cambiata. Cambia tonalità o tempo a
brano fermo: se il brano sta suonando, la rielaborazione lo interrompe per qualche secondo. Sul web il brano si
sente ancora nella tonalità e nel tempo originali.

**Zoom e griglia.** I comandi sono nella barra sopra la forma d'onda, anche mentre modifichi le sezioni, e le scelte
restano salvate su questo computer.

- **−** e **+** (o **Ctrl+rotella** sulla forma d'onda, o due dita su uno schermo touch) cambiano lo zoom fino a ×32; il pulsante accanto riporta tutto il
  brano nella finestra. Con lo zoom la forma d'onda scorre con la rotella o con la barra sotto. A brano in corso segue la
  testina, e dopo uno scorrimento a mano riprende a seguirla dopo 3 secondi.
- Il pulsante della griglia mostra o nasconde le linee con i numeri di battuta. Il menu accanto sceglie la risoluzione:
  *8*, *4*, *2 battute*, *Battuta* o *Movimento*. Se le linee sono troppo fitte ne vedi meno: aumenta lo zoom per vederle tutte.
- La griglia guida il tocco sulla forma d'onda. A brano in corso si arriva al massimo sulla battuta, anche con la risoluzione
  *Movimento*, per non spostare gli accenti rispetto alla musica. Le sezioni partono sempre da una battuta: **+** e il
  trascinamento dei marker non cambiano con la risoluzione.

**Salti.** A brano in corso, tocca l'etichetta di una sezione: il salto va in coda, l'etichetta lampeggia e la musica
arriva lì senza buchi e a tempo con il click. Scegli quando avviene con *Movimento*, *Battuta* o *Fine sezione*. Un
altro tocco sulla stessa etichetta (o *Annulla*, o **Esc**) annulla. A brano fermo il tocco sposta subito la testina.

**Loop.** Come in Playback ce ne sono due, nella console del mixer:

- *Loop* ripete **una volta** la sezione in corso: alla fine torna al suo inizio, poi la musica prosegue.
- *Loop ∞* (**L**, o l'icona del loop sull'etichetta della sezione in corso) la ripete finché non lo premi di nuovo:
  la musica arriva alla fine della sezione e poi continua.

Toccare un'altra sezione esce dal loop e salta lì. Stop e cambio brano annullano salti e loop.

**Creare le sezioni sulla forma d'onda.** Premi **Modifica** nella barra del trasporto (serve poter modificare la scaletta): la forma d'onda si
ingrandisce fino a quando non premi *Fine* nello stesso punto. Un tocco sulla forma d'onda sposta solo la testina e non crea sezioni.

- Porta la testina dove serve e premi **+**: il marker si aggancia alla battuta più vicina. Il primo marker su un brano
  vuoto crea anche *Intro*, perché la prima sezione parte sempre dalla battuta 1.
- Trascina un marker per spostarlo da una battuta all'altra, senza superare quelli vicini.
- Tocca un marker o l'etichetta di una sezione per scegliere la sezione e usa i nomi pronti (*Intro*, *Verse*, *Pre-Chorus*,
  *Chorus*, *Bridge*, *Solo*, *Interlude*, *Outro*). Per scrivere un nome tuo fai **doppio clic** sul campo del nome
  (appena aggiunto un marker il campo è già pronto): **Invio**, **Esc** o un clic altrove lo chiudono, così i tasti della
  vista non lo sovrascrivono. *Elimina* la toglie e le sue battute passano alla sezione prima.
- **Ctrl+Z** annulla, **Ctrl+Shift+Z** ripete. Le modifiche restano su questo computer finché non premi **Salva**, come nell'Arrangement; poi
  valgono per tutta la band.

Le stesse sezioni si modificano anche nella pagina **Scaletta**, scheda **Brano**, *Cambi di tempo*: lì puoi dare a una
sezione un tempo o un metro diversi. Se una sezione cambia il tempo, spostarne il marker sposta anche il cambio.

**Sul web.** L'app web ha un *Player palco* con sezioni, salti, loop, fade e pad. Le sezioni si creano qui. Quando
carichi un brano, e se puoi modificare la scaletta, il desktop salva con la scaletta anche le battute della sua griglia:
così i salti del web cadono sulle stesse battute. Transizioni, tonalità e tempo ci sono solo qui.

I marker non toccano le **cue**: la griglia resta la stessa e le cue già create, live o renderizzate, restano dove sono.
Se il brano ha delle cue, la vista Palco rifiuta solo le modifiche che cambierebbero davvero il tempo, come spostare o
eliminare una sezione con un tempo proprio.

### 4.3 Arrangement

Timeline del brano caricato: righello in battute, corsia delle sezioni, forme d'onda, corsie video, click e
cue, testina che segue. Header delle tracce con M/S e meter (dalla prossima versione volume e uscita sono nel **Mixer**, vedi sotto).

Dalla prossima versione sotto il righello c'è la **corsia delle sezioni**, come la Marker Track di Cubase, con gli stessi
colori della vista Palco:

- **clic** su una sezione: ci vai. A brano in corso il salto avviene senza buchi, nel momento scelto nella vista Palco
  (*Movimento*, *Battuta* o *Fine sezione*). Anche i pulsanti ⏮ ⏭ del gruppo *Sezioni* spostano da una all'altra;
- **trascina l'inizio** di una sezione per spostarlo, a battute;
- **doppio clic** per rinominarla;
- **Ctrl+clic**, per aggiungerne una in quel punto. **Ins** o il **+** nell'intestazione *Sezioni* la aggiungono alla testina.

La tab **Sezioni** del Browser, visibile solo in questa vista, mostra l'elenco, con numero, nome e battuta di partenza: il
numero porta alla sezione, il nome si scrive direttamente nella riga, la × elimina, **Aggiungi** ne crea una alla battuta
della testina. Le modifiche si salvano con **Salva**.

**Ctrl+rotella** = zoom; pulsanti *Segui la testina* e *Adatta alla finestra*.

**Mixer** (dalla prossima versione). Nel Dettaglio, tab **Mixer**, oppure in una finestra separata come la MixConsole di
Cubase: **F3** o il pulsante **Mixer** della barra dell'Arrangement (di nuovo F3 per chiuderla). Una striscia per **ogni traccia del
multitraccia**, nell'ordine della sequenza, più la traccia cue live; le tracce non ancora scaricate compaiono sbiadite e
senza meter, ma si possono già regolare:

- in alto il **menu della destinazione**, come in Cubase: il **ruolo** (*Main (PA)*, *Click*, *Guide / Cue*, *Solo
  monitor*, gli stessi della vista Sequenze della scaletta, che escono dove dice la matrice uscite) oppure un'**uscita
  diretta** di questo computer;
- sotto, per Main e Solo monitor, lo **strumento** (Batteria, Basso, Tastiere…): come nelle Sequenze, il Rehearsal di chi
  lo suona toglie la traccia dal mix;
- **pan**, **fader del volume** con meter (doppio clic: 0 dB / centro), **M** e **S**;
- il **nome** in fondo apre la **sezione canale** della traccia (accanto resta la sua striscia; di nuovo clic sul nome,
  **✕** o **Esc** per tornare al mixer, **‹ ›** per passare alla traccia vicina). Come su un banco digitale:
  - **Gain** d'ingresso (±24 dB), prima dell'EQ, con il meter;
  - **EQ** a 5 bande più **passa alto** e **passa basso** (12 dB/ottava). Il grafico mostra la curva sopra lo
    **spettro della traccia** mentre suona (le frequenze in uso, dopo l'EQ). Si trascina un punto: in orizzontale la
    frequenza, in verticale il guadagno (±15 dB); la **rotella** sul grafico stringe o allarga la campana (Q); doppio clic
    = banda a 0 dB, oppure passa alto/basso acceso/spento. Sotto, i pulsanti **HP 1 2 3 4 5 LP** scelgono la banda e i
    cursori **Freq**, **Gain** e **Q**; ogni banda può essere **Campana**, **Shelf basso** o **Shelf alto** (lo shelf
    non ha Q). **EQ** esclude e riattiva tutto (per il confronto), **Piatto** azzera.
  - Una traccia con gain o EQ modificati ha il segno **EQ** sul nome.

Volume, pan, ruolo, strumento, gain ed EQ si salvano **con il brano** (pulsante **Salva**, anche nel mixer): al prossimo caricamento, su ogni
computer della band e nella prova sul web, il brano suona così. Si annullano con Ctrl+Z nell'Arrangement (un trascinamento
del fader = un passo). **Ripristina volumi** riporta tutte le tracce a 0 dB e pan al centro (gain ed EQ restano: si azzerano con **Piatto**), poi Salva. Mute, solo e
l'uscita diretta restano solo su questo computer. Chi non può modificare il brano vede i volumi ma non li cambia.

**Precount**: battute di count-in prima della battuta 1, uguali per tutti i brani; si impostano in **Impostazioni › Trasporto** e si sentono con il count-in attivo.

### 4.4 Audio e uscite

Dal pulsante della scheda audio nella control bar: scegli il dispositivo e la **matrice uscite**, cioè su
quali canali escono Main, Click, Guide e Monitor. Mute e uscita si possono cambiare per singola
traccia e restano salvati su questo computer; il volume di ogni traccia si regola nel **Mixer** e si salva con il brano
(vedi *Arrangement*). Le uscite che la scheda non ha ricadono su Out 1-2 (comodo
per provare sul portatile).

Su Windows si usa WASAPI condiviso. Il supporto ASIO è in preparazione e non è ancora incluso nelle versioni
pubblicate. Nelle versioni che lo includono, i driver installati compaiono nel gruppo **ASIO** dell'elenco delle
schede: la frequenza di campionamento è quella impostata nel pannello del driver e, di solito, nessun altro
programma può usare la scheda nel frattempo. Se il driver scelto non è disponibile (scheda scollegata o occupata)
LiveTools mostra l'errore nella barra di stato e non passa da solo ad altre uscite: scegli un'altra scheda per
tornare a suonare.

*ASIO is a trademark of Steinberg Media Technologies GmbH, registered in Europe and other countries.*

### 4.5 Rehearsal

Nella barra *Rehearsal* del dettaglio un clic toglie dal mix un intero gruppo (Batteria, Basso, Click
compreso il metronomo, Guide…). Vale per tutti i brani finché l'app resta aperta e non modifica i mute
salvati.

### 4.6 Suonare con la band (Palco Sync)

- **Guida** — il brano caricato qui diventa quello attivo per tutta la band (serve essere proprietario,
  editor o palco della scaletta).
- **Segui palco** — carica il brano attivato dal master (dal web o da un altro desktop).

---

## 5. Click e griglia

### 5.1 Il click

Il click è generato dal motore (nessun campione): **Impostazioni › Trasporto** per suono (Beep, Woodblock,
Cowbell, Stick, HiHat), volume, e volume / intonazione di accento, movimenti, suddivisioni e count-in. Il
count-in segue le stesse regole del metronomo web, con cambi di tempo e metro per sezione.

**Click in ottavi** (dalla prossima versione): il pulsante **×2** del trasporto, **Maiusc+C** o
**Impostazioni › Trasporto › Click in ottavi** raddoppia il click: nei tempi semplici (4/4, 3/4…) suona anche
i controtempi, cioè il 4/4 in ottavi, un po' più piano dei movimenti (regolabili con la voce *Ottavi* di
volume e intonazione). Nei tempi composti (6/8, 12/8) il click è già in ottavi e non cambia; il count-in resta
in quarti.

### 5.2 Griglia allineata all'audio

Al caricamento l'app allinea click, count-in e righello alle tracce:

- **con una traccia click** (ruolo Click o nome "click"/"metronomo"): la griglia segue i colpi battuta per
  battuta, cambi di tempo compresi;
- **senza traccia click**: analizza una traccia ritmica (batteria, perc, loop… o la prima Main) attorno al
  BPM del brano e trova dove cade il "1".

Il menu **Griglia** nell'Arrangement mostra traccia usata, BPM rilevato, posizione del "1" e affidabilità;
permette di scegliere un'altra traccia, usare i *Dati del brano*, spostare il "1" di un movimento (◀ 1 / 1 ▶)
e correggere di ±5 ms.

Dalla prossima versione, se l'audio comincia una battuta o più prima del "1" trovato (succede quando la traccia
di riferimento entra dopo un intro, o con *Analisi da / a*), all'apertura nell'Arrangement la battuta 1 torna
all'inizio dell'audio: la griglia resta a tempo con la musica e conta le battute dall'intro, invece di lasciarlo
prima della battuta -1. Cue e sezioni già create si spostano con lei e restano sulla stessa musica. La
correzione è *Non salvata*: **Salva** per tenerla, **Ctrl+Z** per annullarla. Non tocca le griglie fatte a mano.

### 5.3 Griglia a mano (tasto W)

Per chi può modificare la scaletta. L'audio non cambia: è la griglia che si adatta.

- **Analisi da / a**: limita l'analisi al tratto con ritmo utile (es. dopo un intro libero).
- **Ancoraggi**: trascina una linea di battuta o movimento sul colpo giusto. Ctrl sposta tutta la griglia,
  Shift toglie la calamita sui transienti, doppio clic fissa una linea, Alt+clic toglie un ancoraggio.
- **BPM** e **Tap** (almeno 3 colpi) per scrivere o battere il tempo.
- **Automatica** torna all'analisi.

La griglia è salvata sul brano: vale su tutti i computer della band.

---

## 6. Modificare l'arrangiamento

Strumenti nella barra dell'Arrangement (tasti **1–5**):

| Tasto | Strumento | Uso |
|---|---|---|
| 1 | Selezione | seleziona la traccia; trascinando un bordo accorcia il segmento (l'audio resta dov'è) |
| 2 | Sposta | trascina il segmento intero, da qualsiasi punto (con *Griglia* attiva il suo inizio si aggancia ai movimenti, Shift inverte) |
| 3 | Taglia | taglia dove clicchi |
| 4 | Muta | muta / riattiva un segmento |
| 5 | Elimina | elimina un segmento |

Altre azioni: **Ctrl+E** taglia la traccia selezionata alla testina, **Canc** elimina, **X** muta,
**Ctrl+Z / Ctrl+Shift+Z** annulla / ripeti.

**Aggiungi → Battute…** inserisce battute vuote alla battuta della testina: sposta in avanti stem, cue,
ancoraggi della griglia, cambi del gobbo e sezioni.

Dalla prossima versione un brano parte sempre dal suo primo audio o dalla battuta 1, se viene prima: il vuoto che
li precede viene tolto e il brano si sposta indietro con griglia, cue, gobbo e video. Le battute tra il "1" e
l'audio restano, così un conteggio parlato sulla traccia cue ha il suo spazio; altre battute vuote all'inizio
restano solo se le inserisci con *Aggiungi → Battute…*. Vale anche per i brani già salvati con un vuoto:
all'apertura nell'Arrangement la correzione è *Non salvata*, quindi la tieni con **Salva** o la annulli con
**Ctrl+Z**.

I file audio non vengono mai riscritti: l'app salva solo dove suonare ogni pezzo. Il video si sposta solo se
il taglio è prima del suo inizio.

---

## 7. Traccia cue (guide vocali)

Utile quando un brano non ha una traccia guida.

1. **Aggiungi → Traccia cue** nell'Arrangement.
2. La corsia è divisa in quadratini (quarti o ottavi per battuta): clicca un quadratino e scegli la cue
   ("Strofa", "Ritornello", "Bridge", conteggi…).
3. Hai sbagliato battuta? Dalla prossima versione, con la **freccia**, trascina il quadratino di una cue sul quadratino
   giusto: la cue si sposta lì (se c'era già un'altra cue, la sostituisce). Un clic senza trascinare apre il menu
   come prima. **Ctrl+Z** annulla lo spostamento.
4. La **mano** sposta tutte le cue insieme trascinando (dalla prossima versione non apre il menu: per inserire usa un
   altro strumento), la **gomma** ne cancella una. Dalla prossima versione l'intera traccia cue si sposta anche
   trascinando la sua barra colorata in alto (quella con "CUE") con qualsiasi strumento, o con i pulsanti **‹ ›**
   nell'intestazione: un quadratino alla volta, con **Maiusc** una battuta.

Le cue si sentono subito come traccia *live*, generata su questo computer. Dalla prossima versione il pulsante
**Mixdown** nell'intestazione della traccia cue le trasforma in una vera traccia audio "Cues", caricata online:
compare nell'Arrangement come le altre tracce (con forma d'onda, M e S) e si sente anche dal web. Appena la
traccia audio è pronta, la traccia cue viene **mutata per tutta la band** (pulsante **M** acceso, corsia sbiadita)
e la traccia audio è attiva; premi **Salva** per tenere il muto. Il muto della traccia cue vale per tutti i
computer e per il web, non solo per il tuo: lo togli o lo rimetti con **M** nell'intestazione o nel Mixer.

Se modifichi le cue dopo il mixdown, con la traccia cue muta senti ancora la traccia audio di prima: la corsia lo
segnala ("da aggiornare") e un nuovo **Mixdown** la rifà. Il pulsante con la nuvola elimina la traccia audio e
riattiva la traccia cue. Il Rehearsal e il Player palco del web generano da soli la traccia cue quando non è
muta, sulla griglia pubblicata dal desktop: si sente nel gruppo *Guide* anche senza traccia audio.

Le cue non possono stare nel count-in (lì c'è solo il click). Le cue si creano solo dal desktop. Dalla prossima
versione la prima cue parte sempre dalla battuta 1.1: se la battuta 1 è finita un poco prima dell'inizio del brano
(tracce allineate a mano), all'apertura nell'Arrangement il brano viene riportato a posto.

---

## 8. Gobbo (testo sincronizzato)

Vista **Gobbo** (Tab):

1. **Suddividi il testo** — *Genera dal testo* divide il *Testo gobbo* del brano in slide di 2, 3, 4, 6 righe
   o a blocchi. I blocchi ripetuti (il ritornello) diventano una sola slide che compare più volte nella
   sequenza. Le slide si possono rinominare, modificare, dividere, unire, riordinare.
2. **Registra i cambi** — premi **Registra** (R), poi play; clicca la slide (o **1–9**, **0** = schermo vuoto)
   al momento del cambio, oppure **Invio / ↓** per la successiva. Allo stop i nuovi cambi sostituiscono i
   vecchi nel tratto suonato; Ctrl+Z annulla.
3. **Ritocca** — trascina i cambi nella timeline o spostali di ±50 ms nella lista.

**Uscita gobbo** apre una seconda finestra per lo schermo dei cantanti (doppio clic = schermo intero), con la
slide successiva in piccolo e un anticipo regolabile. Lo stesso gobbo può andare in rete come sorgente
**NDI** (vedi *10. Video*).

Con **Guida** attivo il gobbo arriva anche a telefoni e tablet: nell'app web, pulsante **Gobbo** della
scaletta.

---

## 9. Spartito e pedale

Carica lo spartito del brano nella scheda **Spartito** dell'ispettore (pagina Scaletta o Brani): **Carica
spartito** o trascina il file. Va bene un **PDF** o una **foto/scansione** della pagina (jpg, png, webp; da
LiveTools 0.1.11 — fino alla 0.1.10 solo PDF, e solo dalla scheda *Sequenze, Video & PDF*, dove lo trovi ancora). Si può
caricare anche dall'app web e dall'app tablet. Il file si salva subito per tutta la band e, come stem e video,
viene scaricato su questo computer e funziona offline.

Il campo **Link spartito** resta: se il brano ha uno spartito caricato l'app mostra quello, altrimenti la
vista Spartito offre **Apri il link dello spartito**, che lo apre nel browser.

Vista **Spartito** (Tab): una pagina, o due affiancate quando la vista è larga (*Automatico*). Le pagine si
girano con:

- un **pedale / telecomando Bluetooth** volta-pagine (AirTurn, PageFlip, Donner, iRig BlueTurn…): si abbina
  come una tastiera da *Impostazioni di Windows › Bluetooth e dispositivi*. Di default **Pagina giù**, **→**,
  **↓** = pagina successiva e **Pagina su**, **←**, **↑** = precedente; in questa vista non cambiano brano;
- un clic sulla pagina (terzo sinistro = indietro), **Home** / **Fine** per la prima e l'ultima pagina;
- **F11** o il pulsante in alto a destra per lo schermo intero (Esc per uscire).

Il pedale collegato compare nella barra della vista (pallino verde e nome; a ogni pressione si illumina e
mostra il tasto ricevuto). **Impostazioni › Pedale & spartito** elenca i dispositivi Bluetooth collegati,
permette di provare il pedale e, con **Impara**, di assegnare i tasti di un pedale che ne invia altri
(Spazio, Invio, tasti multimediali…).

### Accordi: sezioni, espressioni e stampa

*Da LiveTools 0.1.11; le stesse funzioni ci sono nell'app web.*

Gli accordi del brano (scheda **Spartito**, campo *Testo e accordi*: ChordPro o accordi sopra il testo) si
dividono in **sezioni** con un'intestazione su una riga sua: `[Strofa 1]`, `[Ritornello]`, `Bridge x2`,
`{start_of_verse: Strofa 2}`. Nel campo allargato (**Allarga**) i pulsanti **Sezioni** sopra il testo la inseriscono dove sta il cursore, già
numerata dopo quelle scritte. Ogni sezione ha una sigla colorata:

| Sigla | Sezione | Sigla | Sezione | Sigla | Sezione |
| --- | --- | --- | --- | --- | --- |
| I | Intro | B | Bridge | Tg | Tag |
| V | Strofa (Verse) | It | Interludio | Bd | Breakdown |
| Pc | Pre-ritornello | Is | Strumentale / Solo | E | Finale (Ending) |
| C | Ritornello (Chorus) | Vp | Vamp | O | Outro |
| Po | Post-ritornello | Ta | Turnaround | | |

Valgono anche i nomi inglesi (*Verse 1*, *Chorus*, *Pre-chorus*…). Se un tipo ha più sezioni, le sigle si
numerano (V1, V2, C1, C2).

I pulsanti di sezioni ed espressioni compaiono solo nel campo allargato; nel campo normale resta il
pulsante **(i)**. Il pulsante **(i)** apre la **legenda**: le sigle con i loro colori e i nomi
accettati, il significato di ogni espressione e come si scrivono intestazioni, espressioni, ripetizioni e
accordi. Si chiude con lo stesso pulsante o con la **×**. Passando col mouse su un'espressione se ne legge il
significato.

- **Espressioni**: i pulsanti **Espressione** (Soft, Build, Full band, Stop, Rallentando…) inseriscono
  `{expr: Soft}`; subito sotto un'intestazione diventa l'indicazione della sezione, altrove una nota a destra.
  In alternativa: `[Strofa 3 | Softly]`.
- **Ripetizioni**: per far tornare una sezione già scritta, riscrivi solo la sua intestazione (es.
  `[Ritornello 1]` senza righe sotto, o `{chorus}`): compare nella **mappa** del brano senza essere ristampata.
  `x2` in fondo all'intestazione la segna come ripetuta.
- Con gli accordi sopra il testo, la riga di accordi si unisce al testo sotto: ogni accordo va sulla sua sillaba.

**Scrivi / Anteprima**: le due schede sopra il campo passano dal testo da scrivere all'anteprima degli accordi
come si leggono (sigle delle sezioni, espressioni, accordi sopra le sillabe). Nell'anteprima i pulsanti **−** e
**+** trasportano di un semitono alla volta, e **Stampa** stampa nella tonalità dell'anteprima.

**Allarga** apre il campo su tutta la finestra, per scrivere più comodamente brani lunghi (con le stesse schede
e gli stessi pulsanti); **Riduci**, **Esc** o un clic fuori dal riquadro lo riportano nella scheda.

**Stampa** (accanto al titolo del campo) stampa gli accordi del brano, o li salva in PDF dalla finestra di
stampa (*Salva come PDF*). Il foglio ha in alto titolo, artista, tonalità, tempo e metro, poi la **mappa** delle
sezioni nell'ordine in cui si suonano (V1 V2 Vp C1… con le ripetizioni), poi le sezioni in riquadri su due
colonne, con la sigla, il nome e l'espressione. In fondo a destra c'è il logo di LiveTools (*Stampato con*). **Stampa accordi** nella barra della pagina Scaletta stampa
tutti i brani della scaletta, uno per pagina, nella tonalità in cui si suonano.

---

## 10. Video

Il video del brano segue l'orologio audio. Si vede nell'anteprima del dettaglio e in una **seconda
finestra** per proiettore o secondo schermo (pulsante nell'Arrangement; doppio clic = schermo intero).
Dalla prossima versione la finestra si apre già a schermo intero, sul secondo schermo se è collegato (doppio clic o
Esc la riportano in finestra), e chiudendo LiveTools si chiudono anche le finestre di video, gobbo e mixer.
I pulsanti *Video* / *Uscita video* e *Uscita gobbo* sono interruttori: il primo tocco accende l'uscita, il secondo la
spegne (il pulsante resta evidenziato finché è accesa); lo stesso fanno **F4** (video) e **F6** (gobbo). Così si
nasconde il proiettore dal computer, senza portare il mouse sul secondo schermo.

### Video in scaletta (dalla prossima versione)

Un elemento di tipo **Video** (vedi 3.3) è un video da solo, con il suo suono, che si lega al brano dopo senza stacchi.
Nel Palco la sua tessera ha l'icona del video; il pulsante con i cursori apre, al posto di tonalità e tempo:

- **Entrata** e **Uscita** — dissolvenza dal nero e verso il nero, di immagine e suono insieme (di serie: entrata netta,
  uscita in 3 secondi). Vale per la finestra video e per l'uscita NDI.
- **Pad** — quanti secondi prima della fine del video entra il **pad**, nella tonalità del brano dopo. Il pad continua
  dentro il brano finché non premi **PAD**: così un brano che parte senza intro ha già la sua nota.

Esempio: video d'ingresso, *Pad 20 s prima della fine*, transizione *AutoLink*. Gli ultimi 20 secondi del video
suonano con il pad nella tonalità del primo brano; il video sfuma al nero e il brano parte esattamente alla fine del
video. Con *Dissolvenza* il brano entra negli ultimi 5 secondi mentre il video sfuma.

### Immagine della scaletta (dalla prossima versione)

Nella barra della pagina **Scaletta**, gruppo *Schermo*, **Immagine…** sceglie un'immagine (JPG, PNG o WebP, fino a
20 MB) da proiettare sull'uscita video quando non c'è nessun video: tra un brano e l'altro, dopo un video, nei brani
senza video. Vale per tutta la band; senza immagine l'uscita resta nera. Passa anche sull'uscita NDI.

### Uscite NDI

Video e gobbo possono andare anche in rete come sorgenti **NDI®**, per vMix, OBS, un mixer video o uno
schermo NDI, senza tenere aperte le finestre di uscita. Si attivano in **Impostazioni › Uscite NDI**:

- **Uscita video** — il video del brano nel player, a tempo con l'audio (prima dell'inizio il primo
  fotogramma, dopo la fine l'ultimo); senza video l'uscita resta nera, o mostra l'immagine della scaletta
  (dalla prossima versione).
- **Uscita gobbo** — la slide del momento e, se attiva, la successiva, a 1920×1080, come nella finestra Gobbo.

I nomi delle sorgenti si possono cambiare; di default sono **LiveTools - Video** e **LiveTools - Gobbo**
(i programmi NDI mostrano davanti il nome del computer: *NOMEPC (LiveTools - Video)*). Serve il runtime NDI: l'installer di LiveTools installa **NDI 6 Runtime** se manca (anche **NDI Tools**,
da [ndi.video](https://ndi.video), lo contiene); se non c'è, le Impostazioni lo segnalano.
Il video viene decodificato con i codec di Windows (MP4/H.264 e gli altri formati che Windows legge).

<small>NDI® is a registered trademark of Vizrt NDI AB.</small>

---

## 11. Problemi frequenti

| Problema | Cosa fare |
|---|---|
| Il login non torna all'app | chiudi la scheda del browser e riprova; controlla che nessun firewall blocchi 127.0.0.1 |
| Un brano non suona offline | nel Browser controlla lo stato dei media e scaricalo di nuovo |
| Il click non è a tempo con la traccia | menu **Griglia**: scegli un'altra traccia di riferimento, oppure **Griglia a mano** |
| Nessun suono su un'uscita | controlla la matrice uscite: le uscite che la scheda non ha vanno su Out 1-2 |
| File AIFF non suonano sul web | normale: Chrome non legge l'AIFF, usa il desktop |
| L'aggiornamento non compare | Impostazioni › Aggiornamenti › *Cerca aggiornamenti* (serve la rete) |
| La sorgente NDI non compare | Impostazioni › Uscite NDI: controlla che non segnali il runtime mancante; il computer che riceve dev'essere sulla stessa rete (e il firewall non deve bloccare LiveTools) |
| Il pedale non gira le pagine | Impostazioni › Pedale & spartito: controlla che sia tra i dispositivi collegati, premilo e usa *Impara* |

## 12. Dove sono i dati

- Scalette, brani, griglia, gobbo, cue: online (Firebase), condivisi con la band.
- Media scaricati, cartella media, uscite, volumi e mute per traccia, scelte del menu Griglia: solo su questo
  computer (`%APPDATA%\it.lecaractere.livetools\` su Windows).
