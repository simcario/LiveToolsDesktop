# LiveTools Desktop — Manuale d'uso

LiveTools Desktop suona le scalette di LiveTools dal vivo: **sequenze multitraccia (stem), click, video e
gobbo**, sincronizzati tra loro e con il resto della band. Usa lo stesso account Google e gli stessi dati
dell'app web: una scaletta creata sul web si apre qui, e viceversa.

> Questo manuale è per chi usa l'app (musicisti, direttore musicale, tecnico). Per compilare l'app e
> pubblicare le versioni vedi [README](../README.md) e [RELEASE.md](RELEASE.md).

---

## 1. Installazione e primo avvio

1. Scarica `LiveTools_<versione>_x64-setup.exe` dall'ultima release:
   <https://github.com/simcario/LiveTools-releases/releases/latest>.
2. Avvia l'installer (installa per tutto il computer, servono i permessi di amministratore). Se mancano,
   installa da solo **WebView2** e **Visual C++ Redistributable**.
3. Apri **LiveTools** e accedi con Google: il login si apre nel browser, poi torna all'app.
4. Se non hai ancora un ruolo, l'app mostra la pagina di attesa: chiedi l'abilitazione all'amministratore
   (dall'app web, *Amministrazione*).

### Aggiornamenti

All'avvio l'app controlla se c'è una nuova versione e la segnala nella **barra di stato**. Non installa mai
niente da sola: per aggiornare apri **Impostazioni › Aggiornamenti** (Ctrl+,) e premi *Installa la x.y.z e riavvia*. L'app si
chiude, si aggiorna e si riapre. Non aggiornare a ridosso di un concerto.

---

## 2. L'interfaccia

| Area | Cosa contiene |
|---|---|
| **Control bar** (in alto) | ⏮ ▶ ■ ⏭, posizione battuta.movimento e tempo, BPM / metro / tonalità, count-in, click, auto-avanzamento, *Segui palco* / *Guida*, scheda audio, impostazioni |
| **Browser** (sinistra) | le tue scalette, i brani con lo stato dei media offline, *Scarica tutta la scaletta* |
| **Vista centrale** | **Session**, **Arrangement**, **Gobbo** o **Spartito** (Tab per cambiare) |
| **Dettaglio** (sotto) | dati del brano, tracce, stato dei download, anteprima video, barra *Rehearsal* |
| **Barra di stato** | pagine **Live** (Ctrl+1), **Scaletta** (Ctrl+2), **Brani** (Ctrl+3); avviso aggiornamenti |

I pannelli intorno alla vista centrale (Browser, Dettaglio e, nelle pagine Scaletta e Brani, l'ispettore) si
chiudono e riaprono con i pulsanti nella Control bar o con **Ctrl+Alt+L / E / R**. Si ridimensionano trascinandone
il bordo; doppio clic sul bordo per tornare alla misura iniziale. Misure e stato restano su questo computer.

### Pagine

- **Live** — il player: Session, Arrangement, Gobbo, Spartito.
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
  pagina).

Ogni modifica finisce nello storico della scaletta. Colonne personalizzate e condivisione si gestiscono
dall'app web.

### 3.2 Libreria brani

Nella pagina **Brani** ogni brano esiste una volta sola e può comparire in più scalette: stem, video, cue e
gobbo appartengono al brano della libreria, quindi una correzione vale ovunque.

- *Importa dalle scalette* porta nella libreria i brani già presenti nelle tue scalette (raggruppa i doppioni
  per titolo, artista e file).
- Eliminare un brano dalla libreria cancella anche le sue tracce e il suo video. Togliere un brano da una
  scaletta, invece, non cancella i file.

### 3.3 Tracce e video

Scheda **Sequenze & Video** del brano (o dal web, *Sequenze & Video*): trascina i file sulla scheda o usa il
pulsante. Per ogni stem scegli:

- **Ruolo** — decide l'uscita della scheda audio: *Main*, *Click*, *Guide/Cue*, *Solo monitor*;
- **Strumento** — Batteria, Basso, Chitarre, Tastiere, Voce, Cori… (serve al Rehearsal);
- nome e mute di default; l'ordine si cambia trascinando la maniglia.

Se le righe sono strette, allarga l'ispettore trascinandone il bordo.

Per il video: un file per brano, con **offset** rispetto all'audio. Formati audio letti: wav, aiff, flac,
mp3, ogg, m4a/aac, alac. Il video è muto (la colonna sonora sta negli stem).

I caricamenti continuano anche se cambi brano o pagina, e ogni file caricato è già nella cache locale.

### 3.4 Scaricare per l'offline

Prima del concerto, nel Browser premi **Scarica tutta la scaletta**: i media finiscono nella cartella media
del computer e l'app suona senza rete. Lo stato di ogni brano è visibile accanto al titolo.

Se carichi un brano che non è ancora sul computer, l'app lo scarica in quel momento: nella barra in alto compare
una barra di avanzamento con la percentuale, che sparisce appena il brano è pronto.

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
| **Tab** | Session → Arrangement → Gobbo → Spartito |
| **Home** | inizio del brano |
| **C** | click acceso / spento |
| **Ctrl+1 / 2 / 3** | pagina Live / Scaletta / Brani |
| **Ctrl+Alt+L / E / R** | apre o chiude Browser / Dettaglio / ispettore |
| **Ctrl+,** | Impostazioni |
| **F1** | Questo manuale (anche dal pulsante **?** in alto) |

*Auto-avanzamento*: a fine brano prepara il successivo.

### 4.2 Session

Griglia stile Ableton: colonne = tracce (gli stem con lo stesso nome in tutta la scaletta), righe = brani.
Il ▶ a destra avvia la scena. In basso il mixer: fader, meter, Mute/Solo, click e master.

### 4.3 Arrangement

Timeline del brano caricato: righello in battute, locator delle sezioni, forme d'onda, corsie video, click e
cue, testina che segue. Header delle tracce con M/S, volume, uscita, meter.
**Ctrl+rotella** = zoom; pulsanti *Segui la testina* e *Adatta alla finestra*.

**Precount**: battute di count-in prima della battuta 1, uguali per tutti i brani; si impostano in **Impostazioni › Trasporto** e si sentono con il count-in attivo.

### 4.4 Audio e uscite

Dal pulsante della scheda audio nella control bar: scegli il dispositivo e la **matrice uscite**, cioè su
quali canali escono Main, Click, Guide e Monitor. Volume, mute e uscita si possono cambiare per singola
traccia e restano salvati su questo computer. Le uscite che la scheda non ha ricadono su Out 1-2 (comodo
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

### 5.2 Griglia allineata all'audio

Al caricamento l'app allinea click, count-in e righello alle tracce:

- **con una traccia click** (ruolo Click o nome "click"/"metronomo"): la griglia segue i colpi battuta per
  battuta, cambi di tempo compresi;
- **senza traccia click**: analizza una traccia ritmica (batteria, perc, loop… o la prima Main) attorno al
  BPM del brano e trova dove cade il "1".

Il menu **Griglia** nell'Arrangement mostra traccia usata, BPM rilevato, posizione del "1" e affidabilità;
permette di scegliere un'altra traccia, usare i *Dati del brano*, spostare il "1" di un movimento (◀ 1 / 1 ▶)
e correggere di ±5 ms.

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

I file audio non vengono mai riscritti: l'app salva solo dove suonare ogni pezzo. Il video si sposta solo se
il taglio è prima del suo inizio.

---

## 7. Traccia cue (guide vocali)

Utile quando un brano non ha una traccia guida.

1. **Aggiungi → Traccia cue** nell'Arrangement.
2. La corsia è divisa in quadratini (quarti o ottavi per battuta): clicca un quadratino e scegli la cue
   ("Strofa", "Ritornello", "Bridge", conteggi…).
3. La **mano** sposta tutte le cue, la **gomma** ne cancella una.

Le cue si sentono subito come traccia *live*, generata su questo computer. Con **Renderizza in file audio**
diventano uno stem "Cues" caricato online, che si ascolta anche dal Rehearsal del web. Se modifichi le cue
dopo il render, l'app usa di nuovo la traccia live finché non renderizzi ancora.

Le cue non possono stare nel count-in (lì c'è solo il click). Le cue si creano solo dal desktop.

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
slide successiva in piccolo e un anticipo regolabile.

Con **Guida** attivo il gobbo arriva anche a telefoni e tablet: nell'app web, pulsante **Gobbo** della
scaletta.

---

## 9. Spartito PDF e pedale

Carica lo spartito del brano nella scheda **Sequenze, Video & PDF** (pagina Scaletta o Brani; anche dall'app
web). Come stem e video viene scaricato su questo computer e funziona offline.

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

---

## 10. Video

Il video del brano segue l'orologio audio. Si vede nell'anteprima del dettaglio e in una **seconda
finestra** per proiettore o secondo schermo (pulsante nell'Arrangement; doppio clic = schermo intero).

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
| Il pedale non gira le pagine | Impostazioni › Pedale & spartito: controlla che sia tra i dispositivi collegati, premilo e usa *Impara* |

## 12. Dove sono i dati

- Scalette, brani, griglia, gobbo, cue: online (Firebase), condivisi con la band.
- Media scaricati, cartella media, uscite, volumi e mute per traccia, scelte del menu Griglia: solo su questo
  computer (`%APPDATA%\it.lecaractere.livetools\` su Windows).
