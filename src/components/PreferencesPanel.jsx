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
import { DEFAULT_PEDAL, keyLabel, PEDAL_LAYOUTS, teachPedal, usePedalTest } from '../shared/score.js';
import Icon from './Icon';

const SECTIONS = [
  { id: 'general', label: 'Generale', icon: 'settings' },
  { id: 'transport', label: 'Trasporto', icon: 'metronome' },
  { id: 'pedal', label: 'Pedale & spartito', icon: 'file-text' },
  { id: 'updates', label: 'Aggiornamenti', icon: 'download' },
];

const SETTINGS = [
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

export default function PreferencesPanel({ settings, update, onClose, initialSection }) {
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
              <button onClick={() => setPedal(settings, update, { [a]: pedal[a].filter((x) => x !== k) })} title="Togli questo tasto">
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
