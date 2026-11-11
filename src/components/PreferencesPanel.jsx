// Preferences laid out like VS Code: sections on the left, the settings of the
// chosen section (or the search results) on the right.
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { engine, engineStatus, useEngineStatus } from '../lib/engine';
import { CLICK_KINDS, CLICK_SOUNDS, DEFAULT_KIND, DEFAULT_SETTINGS, clickKind } from '../lib/settings';
import { checkForUpdates, installUpdate, useUpdater } from '../lib/updater';
import { pedalDevice, useBluetoothDevices } from '../lib/pedal';
import { defaultNdiName, useNdiStatus } from '../lib/ndi';
import { midiOutputs, midiTargeted } from '../lib/midi';
import { instrumentsOf, ROUTE_OFF } from '../shared/midi-patch.js';
import { describeKey, midiInputs, setLearning, unassign } from '../lib/midiLearn';
import { rttText, STAGE_PARTS, useStageNetState } from '../lib/stageNet';
import { DEFAULT_PEDAL, keyLabel, PEDAL_LAYOUTS, teachPedal, usePedalTest } from '../shared/score.js';
import { auth } from '../lib/firebase';
import { useAccount, useAuthUser } from '../lib/data';
import { openUrl } from '@tauri-apps/plugin-opener';
import { openSite, SITE_LABEL } from '../lib/site';
import {
  formatBytes,
  formatPrice,
  level,
  PAID_PLAN_IDS,
  planExpiry,
  PLANS,
  planSource,
  share,
  SOURCE_LABELS,
  usageOf,
} from '../shared/plans.js';
import { driveReady, MEDIA_FORMATS, mediaFormatOf, saveMediaFormat } from '../shared/planGuard.js';
import Icon from './Icon';

// Account page of the web app, where plans are bought (Stripe).
export const WEB_ACCOUNT = 'https://app.livetoolsdaw.com/account';

const SECTIONS = [
  { id: 'account', label: 'Account', icon: 'cloud' },
  { id: 'general', label: 'Generale', icon: 'settings' },
  { id: 'transport', label: 'Trasporto', icon: 'metronome' },
  { id: 'pedal', label: 'Pedale & spartito', icon: 'file-text' },
  { id: 'midi', label: 'MIDI', icon: 'music' },
  { id: 'net', label: 'Rete locale', icon: 'radio' },
  { id: 'ndi', label: 'Uscite NDI', icon: 'radio' },
  { id: 'updates', label: 'Aggiornamenti', icon: 'download' },
];

const SETTINGS = [
  {
    id: 'account.plan',
    section: 'account',
    category: 'Account',
    title: 'Piano e consumi',
    description: 'Il tuo abbonamento, quanti brani hai nella libreria e quanto spazio occupano i tuoi file nel cloud LiveTools.',
    keywords: 'abbonamento piano free plus pro spazio quota brani limite cloud drive',
    Control: AccountPlan,
  },
  {
    id: 'media.location',
    section: 'general',
    category: 'Media',
    title: 'Posizione',
    description:
      'Cartella dove LiveTools tiene stem e video scaricati, i file caricati da questo computer e le tracce cue generate. ' +
      'Cambiandola, i media già presenti vengono spostati nella nuova cartella.',
    Control: MediaLocation,
  },
  {
    id: 'click.enabled',
    section: 'transport',
    category: 'Metronomo',
    title: 'Click durante il brano',
    description: 'Suona il click per tutto il brano (scorciatoia: C). Il count-in suona comunque, se richiesto.',
    Control: ClickEnabled,
  },
  {
    id: 'click.eighths',
    section: 'transport',
    category: 'Metronomo',
    title: 'Click in ottavi',
    description:
      'Raddoppia il click: nei tempi semplici (4/4, 3/4…) suona anche i controtempi, cioè il 4/4 in ottavi, più piano dei movimenti. ' +
      'Nei tempi composti (6/8, 12/8) il click è già in ottavi e non cambia; il count-in resta in quarti. ' +
      'Si attiva anche dal pulsante ×2 del trasporto (scorciatoia: Maiusc+C).',
    keywords: 'raddoppia doppio ottavi suddivisione controtempo double',
    Control: ClickEighths,
  },
  {
    id: 'click.sound',
    section: 'transport',
    category: 'Metronomo',
    title: 'Suono',
    description: 'Timbro del click, generato dal motore audio. Esce sull’uscita “Click” della matrice uscite.',
    Control: ClickSound,
  },
  {
    id: 'click.level',
    section: 'transport',
    category: 'Metronomo',
    title: 'Volume',
    description: 'Livello generale del click (lo stesso fader del mixer).',
    Control: ClickLevel,
  },
  {
    id: 'click.kinds',
    section: 'transport',
    category: 'Metronomo',
    title: 'Volume e intonazione dei movimenti',
    description:
      'Regola ogni tipo di battito rispetto al suono scelto: volume in dB (tutto a sinistra = muto) e intonazione in semitoni.',
    keywords: 'accento battere quarti pitch',
    Control: ClickKinds,
  },
  {
    id: 'transport.countIn',
    section: 'transport',
    category: 'Count-in',
    title: 'All’avvio dall’inizio',
    description: 'Fa partire il brano dopo le battute di count-in quando lo avvii dall’inizio.',
    Control: CountIn,
  },
  {
    id: 'transport.defaultCountIn',
    section: 'transport',
    category: 'Count-in',
    title: 'Precount',
    description:
      'Battute di click prima della battuta 1, uguali per tutti i brani. Il brano caricato si ricarica subito (se è in riproduzione, al prossimo caricamento).',
    keywords: 'count-in battute conteggio',
    Control: Precount,
  },
  {
    id: 'pedal.device',
    section: 'pedal',
    category: 'Pedale',
    title: 'Dispositivo collegato',
    description:
      'I dispositivi Bluetooth collegati a questo computer: il pedale (o telecomando) volta-pagine compare tra i dispositivi di input. ' +
      'Si abbina da Impostazioni di Windows › Bluetooth e dispositivi. Premilo per provarlo: qui sotto vedi il tasto che invia.',
    keywords: 'bluetooth airturn pageflip donner telecomando volta pagine prova test',
    Control: PedalDevice,
  },
  {
    id: 'pedal.keys',
    section: 'pedal',
    category: 'Pedale',
    title: 'Tasti',
    description:
      'Tasti che girano le pagine nella vista Spartito (lì non cambiano brano). Con “Impara” premi il pedale e il tasto che invia viene assegnato.',
    keywords: 'pagina successiva precedente frecce page down up impara',
    Control: PedalKeys,
  },
  {
    id: 'pedal.layout',
    section: 'pedal',
    category: 'Spartito',
    title: 'Pagine',
    description: 'Una pagina o due affiancate; “Automatico” ne mostra due quando la vista è più larga che alta (con due pagine il pedale gira di due).',
    keywords: 'pdf affiancate doppia pagina',
    Control: PedalLayout,
  },
  {
    id: 'midi.output',
    section: 'midi',
    category: 'MIDI',
    title: 'Uscita',
    description:
      'L’interfaccia MIDI (o la tastiera USB) a cui vanno le patch dei brani: Bank Select, Program Change, Control Change e SysEx ' +
      'scritti nella scheda MIDI del brano. Con rtpMIDI le uscite di rete compaiono qui come le altre.',
    keywords: 'midi patch program change bank sysex tastiera nord interfaccia usb rtp rete',
    Control: MidiOutput,
  },
  {
    id: 'midi.auto',
    section: 'midi',
    category: 'MIDI',
    title: 'Cambio patch automatico',
    description:
      'Manda le patch quando un brano diventa quello nel player: caricato, scelto nel Palco o preso da una transizione. ' +
      'Lo stesso brano ricaricato (tonalità, tempo, cue) non le rimanda.',
    keywords: 'midi automatico program change brano',
    Control: MidiAuto,
  },
  {
    id: 'midi.routes',
    section: 'midi',
    category: 'MIDI',
    title: 'Uscita di ogni strumento',
    description:
      'Gli strumenti con una patch nei brani di questa scaletta. Ognuno può andare su un’altra uscita oppure non partire da questo ' +
      'computer (per esempio se il tastierista manda le sue patch dal proprio).',
    keywords: 'midi strumento tastiera routing mappa canale',
    Control: MidiRoutes,
  },
  {
    id: 'midi.learn',
    section: 'midi',
    category: 'MIDI learn',
    title: 'Controlli assegnati',
    description:
      'Un controller MIDI (pedaliera, pad, fader) comanda i controlli di LiveTools. Con MIDI learn (Ctrl+M, o il pulsante con la nota ' +
      'in alto a destra) i controlli assegnabili si illuminano: tocca un controllo, poi premi un tasto o muovi un fader sul controller. ' +
      'Esc esce, Canc toglie il comando al controllo scelto. Le assegnazioni restano su questo computer.',
    keywords: 'midi learn controller pedaliera pedale tasto fader assegna mappa comando',
    Control: MidiLearnList,
  },
  {
    id: 'midi.inputs',
    section: 'midi',
    category: 'MIDI learn',
    title: 'Ingressi',
    description:
      'Da quali ingressi MIDI arrivano i comandi. Si aprono solo mentre ci sono controlli assegnati o MIDI learn è attivo; ' +
      'un ingresso usato da un altro programma non si può aprire.',
    keywords: 'midi ingresso input controller',
    Control: MidiInputs,
  },
  {
    id: 'net.status',
    section: 'net',
    category: 'Rete locale',
    title: 'Band in rete',
    description:
      'Sulla stessa rete Wi-Fi (anche senza internet) chi ha “Guida” manda il brano sul palco a chi ha “Segui palco”, ' +
      'computer e tablet: si trovano da soli e il brano arriva subito. Con internet passa anche dal cloud, come sempre. ' +
      'La prima volta Windows chiede di consentire LiveTools sulle reti private: rispondi Consenti.',
    keywords: 'rete locale lan wifi wi-fi offline senza internet palco sync guida segui band router',
    Control: NetStatus,
  },
  {
    id: 'net.part',
    section: 'net',
    category: 'Rete locale',
    title: 'Ruolo sul palco',
    description: 'Come ti vede il resto della band nell’elenco di chi è collegato.',
    keywords: 'ruolo strumento band nome',
    Control: NetPart,
  },
  {
    id: 'net.address',
    section: 'net',
    category: 'Rete locale',
    title: 'Indirizzo di chi guida',
    description:
      'Di solito vuoto: chi segue trova da solo chi guida la stessa scaletta. Se il router blocca la ricerca, scrivi qui ' +
      'l’indirizzo che compare su chi guida (per esempio 192.168.1.20).',
    keywords: 'indirizzo ip manuale router',
    Control: NetAddress,
  },
  {
    id: 'net.backup',
    section: 'net',
    category: 'Rete locale',
    title: 'Computer di riserva',
    description:
      'Un secondo computer che suona insieme a quello di chi guida: stesso brano, stesso play e stop, stesso punto, sulle sue uscite. ' +
      'Accendilo qui e premi “Segui palco”. Se il computer principale si ferma, sposta i cavi (o usa un commutatore audio): la riserva ' +
      'sta già suonando. Se il principale sparisce dalla rete, la riserva continua e, se lo permetti, guida la band al suo posto.',
    keywords: 'riserva backup ridondanza failover secondo computer emergenza crash commutatore',
    Control: NetBackup,
  },
  {
    id: 'ndi.video',
    section: 'ndi',
    category: 'NDI',
    title: 'Uscita video',
    description:
      'Manda in rete come sorgente NDI il video del brano nel player, a tempo con l’audio, anche con la finestra Uscita video chiusa: ' +
      'la ricevono vMix, OBS, un mixer video o uno schermo NDI. Senza video l’uscita resta nera.',
    keywords: 'ndi rete vmix obs regia proiettore streaming',
    Control: NdiVideo,
  },
  {
    id: 'ndi.prompter',
    section: 'ndi',
    category: 'NDI',
    title: 'Uscita gobbo',
    description:
      'Manda in rete come sorgente NDI il gobbo (1920×1080), uguale alla finestra Gobbo: la slide del momento e, se attiva, la successiva.',
    keywords: 'ndi rete testi slide prompter vmix obs',
    Control: NdiPrompter,
  },
  {
    id: 'updates.version',
    section: 'updates',
    category: 'Aggiornamenti',
    title: 'Versione',
    description:
      'Cerca una nuova versione di LiveTools e la installa: l’app si chiude, l’installazione procede da sola e l’app si riapre. ' +
      'Brani, scalette e media scaricati restano dove sono.',
    keywords: 'update installa',
    Control: UpdateVersion,
  },
  {
    id: 'updates.check',
    section: 'updates',
    category: 'Aggiornamenti',
    title: 'Controlla all’avvio',
    description: 'All’avvio cerca una nuova versione e la segnala nella barra di stato. Non installa mai niente da solo.',
    keywords: 'update automatico',
    Control: UpdateCheck,
  },
];

const matches = (s, q) => `${s.category} ${s.title} ${s.description} ${s.keywords || ''}`.toLowerCase().includes(q);

export default function PreferencesPanel({ settings, update, onClose, initialSection, items = [], onSendMidi }) {
  const [section, setSection] = useState(initialSection || SECTIONS[0].id);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => SETTINGS.filter((s) => (q ? matches(s, q) : s.section === section)), [q, section]);

  return (
    <div className="modal-backdrop">
      <div className="prefs" role="dialog" aria-modal="true" aria-label="Impostazioni">
        <div className="prefs-head">
          <h2>Impostazioni</h2>
          <label className="prefs-search">
            <Icon name="search" size={14} />
            <input autoFocus placeholder="Cerca impostazioni" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button className="btn btn-ghost btn-icon" onClick={onClose} disabled={busy} aria-label="Chiudi">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="prefs-body">
          <nav className="prefs-nav">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={!q && section === s.id ? 'is-on' : ''}
                onClick={() => {
                  setQuery('');
                  setSection(s.id);
                }}
              >
                <Icon name={s.icon} size={14} />
                {s.label}
                {q && <span className="prefs-count">{SETTINGS.filter((x) => x.section === s.id && matches(x, q)).length}</span>}
              </button>
            ))}
            <button className="prefs-site" onClick={() => openSite()} title={`Apri ${SITE_LABEL} nel browser`}>
              <Icon name="globe" size={14} />
              {SITE_LABEL}
            </button>
          </nav>
          <div className="prefs-main">
            <h3>{q ? 'Risultati della ricerca' : SECTIONS.find((s) => s.id === section).label}</h3>
            {shown.map(({ id, category, title, description, Control }) => (
              <Control
                key={id}
                category={category}
                title={title}
                description={description}
                settings={settings}
                update={update}
                onBusy={setBusy}
                items={items}
                onSendMidi={onSendMidi}
                onClose={onClose}
              />
            ))}
            {!shown.length && <p className="hint">Nessuna impostazione trovata.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function PrefItem({ category, title, description, modified, onReset, children }) {
  return (
    <div className={`pref${modified ? ' is-modified' : ''}`}>
      <div className="pref-title">
        {category}: <b>{title}</b>
        {modified && <span className="pref-tag">Modificata</span>}
        {modified && onReset && (
          <button className="pref-reset" onClick={onReset} title="Ripristina il valore predefinito">
            <Icon name="undo" size={12} />
          </button>
        )}
      </div>
      <p className="pref-desc">{description}</p>
      {children}
    </div>
  );
}

// ---------- Account ----------

function UsageBar({ label, used, limit, format = String }) {
  const lv = level(used, limit);
  const finite = Number.isFinite(limit);
  return (
    <div className={`usage usage-${lv}`}>
      <div className="usage-head">
        <span>{label}</span>
        <b>{finite ? `${format(used)} di ${format(limit)}` : format(used)}</b>
      </div>
      {finite && (
        <div className="bar-progress">
          <span style={{ width: `${Math.min(100, 100 * share(used, limit))}%` }} />
        </div>
      )}
      {lv === 'warn' && <span className="hint">Quasi al limite del piano.</span>}
      {lv === 'full' && <span className="hint">Limite del piano raggiunto.</span>}
    </div>
  );
}

function AccountPlan({ onBusy, settings, update, ...item }) {
  const user = useAuthUser() || auth.currentUser;
  const { profile, enforced, superAdmin } = useAccount(user);
  if (!profile) return <PrefItem {...item}><p className="hint">Caricamento…</p></PrefItem>;
  const u = usageOf(profile, { superAdmin });
  const until = planExpiry(profile);
  const source = superAdmin ? null : planSource(profile);
  const p = profile.plan || {};
  // Bought on the web page (Stripe, in the browser, signed in with the same Google account).
  const openAccount = (query = '') => openUrl(`${WEB_ACCOUNT}${query}`).catch(() => {});
  return (
    <PrefItem {...item}>
      <div className="plan-card">
        <div className="plan-name">
          <b>{u.plan.label}</b>
          {source && <span className="hint">{SOURCE_LABELS[source]}</span>}
          {until && <span className="hint">{p.cancelAtPeriodEnd ? 'termina il' : source === 'stripe' ? 'rinnovo entro il' : 'fino al'} {until}</span>}
        </div>
        <p className="hint">{u.plan.summary}</p>
        <UsageBar label="Brani" used={u.songs} limit={u.songLimit} />
        {u.plan.media === 'cloud' && (
          <UsageBar
            label={Number.isFinite(u.storageLimit) ? 'Spazio nel cloud' : 'Spazio usato nel cloud'}
            used={u.bytes}
            limit={u.storageLimit}
            format={formatBytes}
          />
        )}
        {u.plan.media !== 'cloud' && u.bytes > 0 && (
          <UsageBar label="File già nel cloud" used={u.bytes} limit={Infinity} format={formatBytes} />
        )}
        {!enforced && <p className="hint">I limiti dei piani non sono ancora attivi: per ora puoi usare tutto senza restrizioni.</p>}
        {(u.plan.media === 'drive' || profile.drive) && (
          <div className="plan-drive">
            <b>Google Drive</b>
            {driveReady(profile) ? (
              <span className="hint">
                Tracce e video dei tuoi brani vanno sul Drive di <b>{profile.drive.email}</b>, cartella “LiveTools”.
              </span>
            ) : profile.drive?.status === 'revoked' ? (
              <span className="hint usage-alert">L’accesso a {profile.drive.email} è stato revocato: ricollega Drive.</span>
            ) : (
              <span className="hint">Collega il Google Drive dove salvare tracce e video: puoi scegliere qualsiasi account Google.</span>
            )}
            <button className="btn align-start" onClick={() => openAccount('?drive')}>
              <Icon name="cloud" size={14} /> {driveReady(profile) ? 'Cambia account Drive' : 'Collega Google Drive'}
            </button>
            {u.plan.media === 'drive' && (
              <div className="plan-format">
                <b>File WAV, AIFF e FLAC</b>
                {Object.entries(MEDIA_FORMATS).map(([id, label]) => (
                  <label key={id} className="check">
                    <input
                      type="radio"
                      name="media-format"
                      checked={mediaFormatOf(profile) === id}
                      onChange={() => saveMediaFormat(user.uid, id).catch((e) => console.warn('Formato non salvato', e))}
                    />{' '}
                    {label}
                  </label>
                ))}
                <span className="hint">Convertiti qui prima del caricamento; il file originale resta dov’è.</span>
              </div>
            )}
          </div>
        )}
        {u.plan.media === 'cloud' && <p className="hint">Nel cloud WAV, AIFF e FLAC vanno in MP3 a 320 kbps, convertiti qui prima del caricamento.</p>}
        {source === 'play' && <p className="hint">Acquistato con Google Play: lo cambi o lo annulli dal Play Store, sul telefono o tablet.</p>}
        {source === 'stripe' && (
          <button className="btn align-start" onClick={() => openAccount()}>
            <Icon name="cloud" size={14} /> Gestisci abbonamento e fatture
          </button>
        )}
        {!superAdmin && source !== 'play' && source !== 'stripe' && (
          <>
            <div className="plan-offers">
              {PAID_PLAN_IDS.map((id) => (
                <button key={id} className="plan-offer" onClick={() => openAccount(`?plan=${id}&interval=year`)} disabled={u.plan.id === id}>
                  <b>{PLANS[id].label}</b>
                  <span>
                    {formatPrice(PLANS[id].price.month)} / mese · {formatPrice(PLANS[id].price.year)} / anno
                  </span>
                  <span className="hint">{PLANS[id].summary}</span>
                  {PLANS[id].trialDays && !profile.billing?.trialUsed && <span className="hint">Prova gratuita di {PLANS[id].trialDays} giorni</span>}
                </button>
              ))}
            </div>
            <p className="hint">
              Il pagamento si apre nel browser, sulla pagina Account di LiveTools web: entra con lo stesso account Google. Il
              piano vale su computer, web e tablet.
            </p>
          </>
        )}
      </div>
    </PrefItem>
  );
}

// ---------- Generale ----------

function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const samePath = (a, b) => a.trim().replace(/[\\/]+$/, '').toLowerCase() === b.trim().replace(/[\\/]+$/, '').toLowerCase();

function MediaLocation({ onBusy, settings, update, ...item }) {
  const [info, setInfo] = useState(null);
  const [draft, setDraft] = useState('');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    invoke('media_info')
      .then((i) => {
        setInfo(i);
        setDraft(i.path);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const changed = info && draft.trim() && !samePath(draft, info.path);

  const browse = async () => {
    const dir = await open({ directory: true, defaultPath: draft || info?.path, title: 'Cartella dei media' });
    if (typeof dir === 'string') setDraft(dir);
  };

  const apply = async () => {
    const what = info.files ? `${info.files} file (${fmtBytes(info.bytes)})` : 'la cartella dei media';
    if (!confirm(`Spostare ${what} in\n${draft.trim()}?\n\nIl brano caricato verrà fermato e l’app si ricaricherà.`)) return;
    setError(null);
    setProgress({ done: 0, total: info.bytes });
    onBusy(true);
    const unlisten = await listen('media-move-progress', (e) => setProgress(e.payload));
    try {
      await invoke('set_media_dir', { path: draft.trim() });
      // Local paths are held all over the player: start again from the new folder.
      window.location.reload();
    } catch (e) {
      setError(String(e));
      setProgress(null);
      onBusy(false);
    } finally {
      unlisten();
    }
  };

  return (
    <PrefItem {...item} modified={info && !info.isDefault}>
      <div className="pref-row">
        <input
          className="input mono"
          value={draft}
          disabled={!info || !!progress}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && changed && apply()}
        />
        <button className="btn" onClick={browse} disabled={!info || !!progress}>
          Sfoglia…
        </button>
      </div>
      {progress ? (
        <div className="pref-progress">
          <div className="bar-progress">
            <span style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 100}%` }} />
          </div>
          <span className="hint">
            Spostamento… {fmtBytes(progress.done)} di {fmtBytes(progress.total)}
          </span>
        </div>
      ) : (
        <div className="pref-row">
          {changed ? (
            <>
              <button className="btn btn-primary btn-sm" onClick={apply}>
                Sposta i media qui
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setDraft(info.path)}>
                Annulla
              </button>
            </>
          ) : (
            info && <span className="hint">{info.files ? `${info.files} file · ${fmtBytes(info.bytes)}` : 'Cartella vuota'}</span>
          )}
          {info && !info.isDefault && !samePath(draft, info.defaultPath) && (
            <button className="btn btn-ghost btn-sm" onClick={() => setDraft(info.defaultPath)} title={info.defaultPath}>
              Ripristina predefinita
            </button>
          )}
        </div>
      )}
      {error && <p className="pref-error">{error}</p>}
    </PrefItem>
  );
}

// ---------- MIDI ----------

// The MIDI outputs, read when the section opens and with “Aggiorna” (an interface plugged in later).
function useMidiOutputs() {
  const [ports, setPorts] = useState(null);
  const [error, setError] = useState(null);
  const refresh = () =>
    midiOutputs()
      .then((p) => {
        setPorts(p);
        setError(null);
      })
      .catch((e) => {
        setPorts([]);
        setError(String(e?.message || e));
      });
  useEffect(() => {
    refresh();
  }, []);
  return { ports, error, refresh };
}

const setMidi = (update, patch) => update((s) => ({ midi: { ...s.midi, ...patch } }));

function MidiOutput({ settings, update, onBusy, items, onSendMidi, ...item }) {
  const { ports, error, refresh } = useMidiOutputs();
  const [test, setTest] = useState(null);
  const out = settings.midi.output;
  const sendNow = async () => {
    setTest('Invio…');
    try {
      const n = await onSendMidi?.();
      setTest(n == null ? 'Nessun brano nel player con patch MIDI.' : `Inviati ${n} messaggi.`);
    } catch (e) {
      setTest(String(e?.message || e));
    }
  };
  return (
    <PrefItem {...item} modified={!!out} onReset={() => setMidi(update, { output: D.midi.output })}>
      <div className="pref-row">
        <select className="select pref-select" value={out} onChange={(e) => setMidi(update, { output: e.target.value })}>
          <option value="">Nessuna</option>
          {(ports || []).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          {out && ports && !ports.includes(out) && <option value={out}>{out} (non collegata)</option>}
        </select>
        <button className="btn btn-sm" onClick={refresh} title="Cerca di nuovo le interfacce MIDI collegate">
          Aggiorna
        </button>
        {midiTargeted(settings.midi) && (
          <button className="btn btn-sm" onClick={sendNow} title="Manda adesso le patch del brano nel player">
            Invia ora
          </button>
        )}
      </div>
      {ports && !ports.length && !error && <span className="hint">Nessuna interfaccia MIDI collegata.</span>}
      {test && <span className="hint">{test}</span>}
      {error && <p className="pref-error">{error}</p>}
    </PrefItem>
  );
}

function MidiAuto({ settings, update, onBusy, items, onSendMidi, ...item }) {
  const on = settings.midi.auto;
  return (
    <PrefItem {...item} modified={on !== D.midi.auto} onReset={() => setMidi(update, { auto: D.midi.auto })}>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => setMidi(update, { auto: e.target.checked })} />
        Invia le patch a ogni cambio di brano
      </label>
    </PrefItem>
  );
}

function MidiRoutes({ settings, update, onBusy, items, onSendMidi, ...item }) {
  const { ports } = useMidiOutputs();
  const routes = settings.midi.routes;
  const names = instrumentsOf(items);
  const setRoute = (name, value) => {
    const next = { ...routes };
    if (value) next[name] = value;
    else delete next[name];
    setMidi(update, { routes: next });
  };
  return (
    <PrefItem {...item} modified={Object.keys(routes).length > 0} onReset={() => setMidi(update, { routes: {} })}>
      {!names.length && <span className="hint">Nessun brano di questa scaletta ha patch MIDI.</span>}
      {names.map((name) => {
        const r = routes[name] || '';
        return (
          <div key={name} className="pref-row pref-midi-route">
            <span className="pref-midi-name">{name}</span>
            <select className="select pref-select" value={r} onChange={(e) => setRoute(name, e.target.value)}>
              <option value="">{settings.midi.output ? `Uscita: ${settings.midi.output}` : 'Uscita (nessuna)'}</option>
              {(ports || []).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
              {r && r !== ROUTE_OFF && ports && !ports.includes(r) && <option value={r}>{r} (non collegata)</option>}
              <option value={ROUTE_OFF}>Non inviare da questo computer</option>
            </select>
          </div>
        );
      })}
    </PrefItem>
  );
}

function MidiLearnList({ settings, update, onBusy, items, onSendMidi, onClose, ...item }) {
  const entries = Object.entries(settings.midi.map).sort((a, b) => a[1].name.localeCompare(b[1].name));
  return (
    <PrefItem {...item} modified={entries.length > 0} onReset={() => update((s) => ({ midi: { ...s.midi, map: {} } }))}>
      <div className="pref-row">
        <button
          className="btn btn-sm"
          onClick={() => {
            onClose?.();
            setLearning(true);
          }}
          title="Chiude le impostazioni e attiva MIDI learn (Ctrl+M)"
        >
          Attiva MIDI learn
        </button>
      </div>
      {!entries.length && <span className="hint">Nessun controllo assegnato.</span>}
      {entries.map(([id, a]) => (
        <div key={id} className="pref-row pref-midi-route">
          <span className="pref-midi-name" title={a.name}>
            {a.name}
          </span>
          <span className="pref-value mono pref-midi-key">{describeKey(a.key)}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => unassign(update, id)} title="Togli il comando MIDI">
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </PrefItem>
  );
}

function MidiInputs({ settings, update, onBusy, items, onSendMidi, onClose, ...item }) {
  const [ports, setPorts] = useState(null);
  const refresh = () =>
    midiInputs()
      .then(setPorts)
      .catch(() => setPorts([]));
  useEffect(() => {
    refresh();
  }, []);
  const chosen = settings.midi.inputs;
  const all = !Array.isArray(chosen);
  const setInputs = (inputs) => update((s) => ({ midi: { ...s.midi, inputs } }));
  const toggle = (name, on) => {
    const cur = all ? (ports || []).map((p) => p.name) : chosen;
    setInputs(on ? [...new Set([...cur, name])] : cur.filter((n) => n !== name));
  };
  return (
    <PrefItem {...item} modified={!all} onReset={() => setInputs(null)}>
      <label className="check">
        <input type="checkbox" checked={all} onChange={(e) => setInputs(e.target.checked ? null : (ports || []).map((p) => p.name))} />
        Tutti gli ingressi
      </label>
      {(ports || []).map((p) => (
        <div key={p.name} className="pref-row">
          <label className="check">
            <input type="checkbox" checked={all || chosen.includes(p.name)} disabled={all} onChange={(e) => toggle(p.name, e.target.checked)} />
            {p.name}
          </label>
          {p.listening && <span className="pref-tag">In ascolto</span>}
          {p.error && <span className="pref-error">{p.error}</span>}
        </div>
      ))}
      {ports && !ports.length && <span className="hint">Nessun ingresso MIDI collegato.</span>}
      <div className="pref-row">
        <button className="btn btn-sm" onClick={refresh}>
          Aggiorna
        </button>
      </div>
    </PrefItem>
  );
}

// ---------- Rete locale ----------

const setNet = (update, patch) => update((s) => ({ stageNet: { ...s.stageNet, ...patch } }));

function NetStatus({ settings, update, onBusy, items, onSendMidi, onClose, ...item }) {
  const net = useStageNetState();
  const [address, setAddress] = useState(null);
  useEffect(() => {
    invoke('stage_net_address').then(setAddress).catch(() => {});
  }, [net.hosting]);
  const on = settings.stageNet.enabled;
  let status;
  if (!on) status = 'Spenta: la band si sincronizza solo via internet.';
  else if (net.hosting) status = `Guidi la band${address ? ` da ${address}` : ''}: ${net.peers.length === 1 ? '1 collegato' : `${net.peers.length} collegati`}.`;
  else if (net.connected) status = `Segui ${net.host?.name || net.joined} · ${rttText(net.rtt)}`;
  else if (settings.followStage) status = net.joined ? `Cerco di collegarmi a ${net.joined}…` : 'Cerco chi guida questa scaletta in rete…';
  else status = 'Attiva “Guida” o “Segui palco” nella barra in alto.';
  return (
    <PrefItem {...item} modified={!on} onReset={() => setNet(update, { enabled: true })}>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => setNet(update, { enabled: e.target.checked })} />
        Usa la rete locale
      </label>
      <span className="hint">{status}</span>
      {net.error && <p className="pref-error">{net.error}</p>}
      {net.peers.map((p) => (
        <div key={p.id || p.addr} className="pref-row pref-midi-route">
          <span className="pref-midi-name">{p.name}</span>
          <span className="pref-value">{[p.part, p.device === 'tablet' ? 'tablet' : 'computer'].filter(Boolean).join(' · ')}</span>
          <span className="pref-value mono">{rttText(p.rtt)}</span>
        </div>
      ))}
    </PrefItem>
  );
}

function NetPart({ settings, update, onBusy, items, onSendMidi, onClose, ...item }) {
  const part = settings.stageNet.part;
  return (
    <PrefItem {...item} modified={!!part} onReset={() => setNet(update, { part: '' })}>
      <select className="select pref-select" value={part} onChange={(e) => setNet(update, { part: e.target.value })}>
        <option value="">Nessuno</option>
        {STAGE_PARTS.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
      </select>
    </PrefItem>
  );
}

function NetBackup({ settings, update, onBusy, items, onSendMidi, onClose, ...item }) {
  const { backup, takeover } = settings.stageNet;
  return (
    <PrefItem {...item} modified={!!backup || !takeover} onReset={() => setNet(update, { backup: false, takeover: true })}>
      <label className="check">
        <input type="checkbox" checked={!!backup} onChange={(e) => setNet(update, { backup: e.target.checked })} />
        Questo computer è la riserva
      </label>
      <label className="check">
        <input type="checkbox" checked={takeover !== false} disabled={!backup} onChange={(e) => setNet(update, { takeover: e.target.checked })} />
        Se il principale sparisce dalla rete, guida la band al suo posto
      </label>
      {backup && !settings.followStage && <span className="hint">Premi “Segui palco” per agganciarti a chi guida.</span>}
    </PrefItem>
  );
}

function NetAddress({ settings, update, onBusy, items, onSendMidi, onClose, ...item }) {
  const net = useStageNetState();
  const saved = settings.stageNet.address;
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const commit = () => draft.trim() !== saved && setNet(update, { address: draft.trim() });
  return (
    <PrefItem {...item} modified={!!saved} onReset={() => setNet(update, { address: '' })}>
      <div className="pref-row">
        <input
          className="input"
          value={draft}
          placeholder="Trovato da solo"
          spellCheck={false}
          aria-label="Indirizzo di chi guida"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </div>
      {net.beacons.length > 0 && (
        <span className="hint">In rete: {net.beacons.map((b) => `${b.name} (${b.title || 'scaletta'}) ${b.addr}`).join(' · ')}</span>
      )}
    </PrefItem>
  );
}

// ---------- Uscite NDI ----------

function NdiOutput({ kind, settings, update, onBusy, ...item }) {
  const ndi = useNdiStatus();
  const out = settings.ndi[kind];
  const [draft, setDraft] = useState(out.name);
  useEffect(() => setDraft(out.name), [out.name]);
  const fallback = defaultNdiName(kind);
  const set = (patch) => update((s) => ({ ndi: { ...s.ndi, [kind]: { ...s.ndi[kind], ...patch } } }));
  // The source is renamed when the field is left, not at every key.
  const commit = () => draft.trim() !== out.name && set({ name: draft.trim() });
  const on = ndi[kind];

  return (
    <PrefItem {...item} modified={out.enabled || !!out.name} onReset={() => set({ ...D.ndi[kind] })}>
      <label className="check">
        <input type="checkbox" checked={out.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Attiva
      </label>
      <div className="pref-row">
        <input
          className="input"
          value={draft}
          placeholder={fallback}
          spellCheck={false}
          aria-label="Nome della sorgente NDI"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </div>
      {out.enabled && (on ? <span className="hint">In rete come “{out.name || fallback}”</span> : ndi.error && <p className="pref-error">{ndi.error}</p>)}
    </PrefItem>
  );
}

// Declarations, not consts: SETTINGS (above) uses them while the module loads.
function NdiVideo(props) {
  return <NdiOutput kind="video" {...props} />;
}

function NdiPrompter(props) {
  return <NdiOutput kind="prompter" {...props} />;
}

// ---------- Aggiornamenti ----------

function UpdateVersion({ onBusy, settings, update, ...item }) {
  const u = useUpdater();
  const busy = u.status === 'downloading' || u.status === 'installing';
  useEffect(() => onBusy(busy), [busy, onBusy]);

  const install = () => {
    if (engineStatus().playing && !confirm('Un brano è in riproduzione: l’aggiornamento chiude l’app e ferma l’audio. Continuare?')) return;
    engine.stop();
    installUpdate();
  };

  return (
    <PrefItem {...item}>
      <div className="pref-row">
        <span className="mono">LiveTools {u.current || '…'}</span>
        {u.status === 'available' && <span className="pref-tag">Disponibile la {u.version}</span>}
      </div>
      {busy ? (
        <div className="pref-progress">
          <div className="bar-progress">
            <span style={{ width: `${u.total ? (100 * u.done) / u.total : 100}%` }} />
          </div>
          <span className="hint">
            {u.status === 'installing'
              ? 'Avvio dell’installazione…'
              : `Download della ${u.version}… ${fmtBytes(u.done)}${u.total ? ` di ${fmtBytes(u.total)}` : ''}`}
          </span>
        </div>
      ) : (
        <div className="pref-row">
          {u.status === 'available' ? (
            <button className="btn btn-primary btn-sm" onClick={install}>
              Installa la {u.version} e riavvia
            </button>
          ) : (
            <button className="btn btn-sm" onClick={() => checkForUpdates()} disabled={u.status === 'checking'}>
              {u.status === 'checking' ? 'Ricerca…' : 'Cerca aggiornamenti'}
            </button>
          )}
          {u.status === 'none' && <span className="hint">Hai già l’ultima versione.</span>}
        </div>
      )}
      {u.status === 'available' && u.notes && <p className="pref-desc pref-notes">{u.notes}</p>}
      {u.status === 'error' && <p className="pref-error">Aggiornamento non riuscito: {u.error}</p>}
    </PrefItem>
  );
}

function UpdateCheck({ settings, update, onBusy, ...item }) {
  return (
    <PrefItem {...item} modified={settings.updateCheck !== D.updateCheck} onReset={() => update({ updateCheck: D.updateCheck })}>
      <label className="check">
        <input type="checkbox" checked={settings.updateCheck} onChange={(e) => update({ updateCheck: e.target.checked })} />
        Cerca aggiornamenti all’avvio
      </label>
    </PrefItem>
  );
}

// ---------- Trasporto ----------

const D = DEFAULT_SETTINGS;
const setClick = (settings, update, patch) => update({ click: { ...settings.click, ...patch } });

function ClickEnabled({ settings, update, onBusy, ...item }) {
  const on = settings.click.enabled;
  return (
    <PrefItem {...item} modified={on !== D.click.enabled}>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => setClick(settings, update, { enabled: e.target.checked })} />
        Attivo
      </label>
    </PrefItem>
  );
}

function ClickEighths({ settings, update, onBusy, ...item }) {
  const on = !!settings.click.eighths;
  return (
    <PrefItem {...item} modified={on !== D.click.eighths}>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => setClick(settings, update, { eighths: e.target.checked })} />
        Suona gli ottavi
      </label>
    </PrefItem>
  );
}

/** Plays one click, or a bar (accent + three beats), while the transport is stopped. */
function usePreview() {
  const playing = useEngineStatus((s) => s.playing);
  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const play = (kinds) => {
    timers.current.forEach(clearTimeout);
    timers.current = kinds.map((k, i) => setTimeout(() => engine.previewClick(k), i * 500));
  };
  return { playing, play };
}

function PreviewButton({ preview, kinds, label = 'Ascolta' }) {
  return (
    <button
      className="btn btn-sm"
      onClick={() => preview.play(kinds)}
      disabled={preview.playing}
      title={preview.playing ? 'L’anteprima suona a trasporto fermo' : undefined}
    >
      <Icon name="play" size={12} /> {label}
    </button>
  );
}

function ClickSound({ settings, update, onBusy, ...item }) {
  const preview = usePreview();
  const sound = settings.click.sound || 'beep';
  const off = settings.outputs.click?.mode === 'off';
  return (
    <PrefItem {...item} modified={sound !== D.click.sound} onReset={() => setClick(settings, update, { sound: D.click.sound })}>
      <div className="pref-row">
        <select className="select pref-select" value={sound} onChange={(e) => setClick(settings, update, { sound: e.target.value })}>
          {CLICK_SOUNDS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <PreviewButton preview={preview} kinds={['accent', 'beat', 'beat', 'beat']} label="Ascolta una battuta" />
      </div>
      {off && <p className="hint">L’uscita “Click” è impostata su “Nessuna”: cambiala in Audio & uscite per sentire il click.</p>}
    </PrefItem>
  );
}

function ClickLevel({ settings, update, onBusy, ...item }) {
  const db = settings.click.gainDb;
  return (
    <PrefItem {...item} modified={db !== D.click.gainDb} onReset={() => setClick(settings, update, { gainDb: D.click.gainDb })}>
      <div className="pref-row">
        <input
          className="slider pref-slider"
          type="range"
          min={-60}
          max={6}
          step={0.5}
          value={db}
          onChange={(e) => setClick(settings, update, { gainDb: Number(e.target.value) })}
        />
        <span className="pref-value mono">{db <= -60 ? 'Muto' : `${db.toFixed(1)} dB`}</span>
      </div>
    </PrefItem>
  );
}

const sameKind = (a) => a.db === DEFAULT_KIND.db && a.semitones === DEFAULT_KIND.semitones;

function ClickKinds({ settings, update, onBusy, ...item }) {
  const preview = usePreview();
  const kinds = CLICK_KINDS.map(([k, label, hint]) => ({ k, label, hint, ...clickKind(settings.click, k) }));
  const setKind = (k, patch) =>
    setClick(settings, update, { kinds: { ...settings.click.kinds, [k]: { ...clickKind(settings.click, k), ...patch } } });
  return (
    <PrefItem
      {...item}
      modified={kinds.some((x) => !sameKind(x))}
      onReset={() => setClick(settings, update, { kinds: {} })}
    >
      <div className="pref-kinds">
        <span className="pk-head" />
        <span className="pk-head">Volume</span>
        <span className="pk-head">Intonazione</span>
        <span className="pk-head" />
        {kinds.map(({ k, label, hint, db, semitones }) => (
          <div key={k} className="pk-row">
            <span className="pk-name" title={hint}>
              {label}
              <small>{hint}</small>
            </span>
            <span className="pk-ctl">
              <input
                className="slider"
                type="range"
                min={-40}
                max={6}
                step={1}
                value={db}
                onChange={(e) => setKind(k, { db: Number(e.target.value) })}
                onDoubleClick={() => setKind(k, { db: 0 })}
                title="Doppio clic: 0 dB"
              />
              <span className="pref-value mono">{db <= -40 ? 'Muto' : `${db > 0 ? '+' : ''}${db} dB`}</span>
            </span>
            <span className="pk-ctl">
              <input
                className="slider"
                type="range"
                min={-12}
                max={12}
                step={1}
                value={semitones}
                onChange={(e) => setKind(k, { semitones: Number(e.target.value) })}
                onDoubleClick={() => setKind(k, { semitones: 0 })}
                title="Doppio clic: intonazione del suono"
              />
              <span className="pref-value mono">
                {semitones > 0 ? '+' : ''}
                {semitones} st
              </span>
            </span>
            <span className="pk-actions">
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => preview.play([k])} disabled={preview.playing} title="Ascolta">
                <Icon name="play" size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>
      {preview.playing && <p className="hint">L’anteprima suona a trasporto fermo.</p>}
    </PrefItem>
  );
}

function CountIn({ settings, update, onBusy, ...item }) {
  return (
    <PrefItem {...item} modified={settings.countIn !== D.countIn}>
      <label className="check">
        <input type="checkbox" checked={settings.countIn} onChange={(e) => update({ countIn: e.target.checked })} />
        Count-in all’avvio dall’inizio
      </label>
    </PrefItem>
  );
}

const MAX_COUNT_IN = 8;

function Precount({ settings, update, onBusy, ...item }) {
  const n = Number(settings.defaultCountIn) || 0;
  const set = (v) => update({ defaultCountIn: Math.min(MAX_COUNT_IN, Math.max(0, v)) });
  return (
    <PrefItem {...item} modified={n !== D.defaultCountIn} onReset={() => set(D.defaultCountIn)}>
      <div className="pref-row">
        <button className="btn btn-sm btn-icon" onClick={() => set(n - 1)} disabled={n <= 0} title="Una battuta in meno">
          <Icon name="minus" size={12} />
        </button>
        <span className="pref-value mono pref-count">{n}</span>
        <button className="btn btn-sm btn-icon" onClick={() => set(n + 1)} disabled={n >= MAX_COUNT_IN} title="Una battuta in più">
          <Icon name="plus" size={12} />
        </button>
        <span className="hint">{n === 0 ? 'Nessun precount' : n === 1 ? '1 battuta' : `${n} battute`}</span>
      </div>
    </PrefItem>
  );
}

// ---------- Pedale & spartito ----------

const setPedal = (settings, update, patch) => update({ pedal: { ...settings.pedal, ...patch } });
const ACTIONS = { next: 'Pagina successiva', prev: 'Pagina precedente' };

function PedalDevice({ settings, update, onBusy, ...item }) {
  const { devices, error } = useBluetoothDevices();
  const last = usePedalTest({ pedal: settings.pedal });
  const pedal = pedalDevice(devices);
  return (
    <PrefItem {...item}>
      <div className="pedal-devices">
        {devices === null && !error && <span className="hint">Cerco i dispositivi…</span>}
        {devices?.length === 0 && <span className="hint">Nessun dispositivo Bluetooth collegato.</span>}
        {devices?.map((d) => (
          <div key={d.id} className={`pedal-device ${d.input ? 'is-input' : ''}`}>
            <span className="sc-dot" />
            <span className="ellipsis">{d.name || 'Senza nome'}</span>
            <span className="hint">
              {d.input ? 'Input · ' : ''}
              {d.kind === 'le' ? 'Bluetooth LE' : 'Bluetooth'}
            </span>
            {d === pedal && <span className="pref-tag">Pedale</span>}
          </div>
        ))}
      </div>
      {error && <p className="pref-error">Bluetooth non disponibile: {error}</p>}
      <div className={`pedal-test ${last ? 'is-hit' : ''}`} key={last?.at}>
        {last ? (
          <>
            Ricevuto <span className="kbd">{keyLabel(last.key)}</span>
            <span>→ {last.action ? ACTIONS[last.action] : 'non assegnato (usa “Impara” qui sotto)'}</span>
          </>
        ) : (
          <span className="hint">Premi il pedale per provarlo.</span>
        )}
      </div>
    </PrefItem>
  );
}

function PedalKeys({ settings, update, onBusy, ...item }) {
  const [learn, setLearn] = useState(null);
  const pedal = settings.pedal;
  usePedalTest({
    active: !!learn,
    pedal,
    learn,
    onLearn: (action, key) => {
      update({ pedal: teachPedal(pedal, action, key) });
      setLearn(null);
    },
  });
  const modified = ['next', 'prev'].some((a) => pedal[a].join() !== DEFAULT_PEDAL[a].join());
  return (
    <PrefItem
      {...item}
      modified={modified}
      onReset={() => setPedal(settings, update, { next: DEFAULT_PEDAL.next, prev: DEFAULT_PEDAL.prev })}
    >
      {['next', 'prev'].map((a) => (
        <div key={a} className="pref-row pedal-keys">
          <span className="pedal-action">{ACTIONS[a]}</span>
          {pedal[a].map((k) => (
            <span key={k} className="kbd pedal-key">
              {keyLabel(k)}
              <button
                onClick={() =>
                  confirm(`Togliere il tasto ${keyLabel(k)} dal pedale?`) && setPedal(settings, update, { [a]: pedal[a].filter((x) => x !== k) })
                }
                title="Togli questo tasto"
              >
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
          {learn === a ? (
            <button className="btn btn-sm btn-primary" onClick={() => setLearn(null)}>
              Premi il pedale… (annulla)
            </button>
          ) : (
            <button className="btn btn-sm" onClick={() => setLearn(a)}>
              Impara
            </button>
          )}
        </div>
      ))}
      {[...pedal.next, ...pedal.prev].some((k) => k === 'Space' || k === 'Enter') && (
        <p className="hint">Nella vista Spartito Spazio / Invio girano la pagina invece di avviare il brano.</p>
      )}
    </PrefItem>
  );
}

function PedalLayout({ settings, update, onBusy, ...item }) {
  const layout = settings.pedal.layout;
  return (
    <PrefItem {...item} modified={layout !== DEFAULT_PEDAL.layout} onReset={() => setPedal(settings, update, { layout: DEFAULT_PEDAL.layout })}>
      <select className="select pref-select" value={layout} onChange={(e) => setPedal(settings, update, { layout: e.target.value })}>
        {PEDAL_LAYOUTS.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
    </PrefItem>
  );
}
