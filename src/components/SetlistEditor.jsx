import { useCallback, useEffect, useRef, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import {
  BREAK_KINDS,
  CLICK_MODES,
  draftUnchanged,
  expectedEnd,
  formatClock,
  formatDuration,
  formatLong,
  isSeparator,
  itemDraft,
  itemFromDraft,
  parseDuration,
  PLAYBACK_TYPES,
  selectChoices,
  setlistStats,
  TIME_SIGNATURES,
  toggleOptions,
  totalDuration,
} from '../shared/setlists.js';
import { chartLyricBlocks, KEYS, lyricBlocksText, plainLyricBlocks } from '../shared/music.js';
import { deleteItemMedia, stemsOf, videoOf } from '../shared/media.js';
import { autoSnapshot, logChange } from '../shared/history.js';
import { createSong, itemFromSong, updateSong, useLibrary } from '../shared/songs.js';
import { useAccess } from '../lib/data';
import { db, storage } from '../lib/firebase';
import Icon from './Icon';
import MediaFields from './MediaFields';

// Setlist page: the same editing as the web app (songs and blocks, order,
// built-in fields, custom column values, lyrics for the prompter), saved on
// the same documents, plus stems and video. Columns and sharing stay on the
// web app.

const TABS = [
  ['song', 'Brano'],
  ['stage', 'Palco'],
  ['chart', 'Spartito'],
  ['lyrics', 'Testo gobbo'],
  ['media', 'Sequenze, Video & PDF'],
  ['midi', 'MIDI'],
  ['columns', 'Colonne'],
];

const EMPTY_ENTRY = { title: '', playback: '', key: '', bpm: '', duration: '' };

// ---------- Custom column value in a row ----------
function Cell({ column, value, canEdit, onSet }) {
  switch (column.type) {
    case 'checkbox':
      return (
        <button className={`toggle ${value ? 'is-yes' : ''}`} disabled={!canEdit} onClick={() => onSet(!value)}>
          {value ? 'SÌ' : 'NO'}
        </button>
      );
    case 'toggle':
      return (
        <button className={`toggle ${value ? 'is-on' : ''}`} disabled={!canEdit} onClick={() => onSet(!value)}>
          {toggleOptions(column)[value ? 1 : 0]}
        </button>
      );
    case 'select':
      return (
        <select className="select-xs" value={value || ''} disabled={!canEdit} onChange={(e) => onSet(e.target.value || null)}>
          <option value="">—</option>
          {selectChoices(column).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      );
    default:
      return (
        <span className="small muted ellipsis" title={value || ''}>
          {value || ''}
        </span>
      );
  }
}

// ---------- Quick entry (same as the web app) ----------
function QuickEntry({ nextNumber, endTime, library, onAddSong, onAddFromLibrary, onAddBreak }) {
  const [d, setD] = useState(EMPTY_ENTRY);
  const titleRef = useRef(null);
  const set = (k) => (e) => setD((x) => ({ ...x, [k]: e.target.value }));
  // A title of the library (suggested while typing) adds that song with its tracks.
  const fromLibrary = library?.find((s) => (s.title || '').trim().toLowerCase() === d.title.trim().toLowerCase()) || null;

  const submit = (e) => {
    e.preventDefault();
    const title = d.title.trim();
    if (!title) return;
    if (fromLibrary) {
      onAddFromLibrary(fromLibrary);
    } else {
      onAddSong({
        title,
        playback: d.playback || null,
        key: d.key.trim() || null,
        bpm: Number(d.bpm) || null,
        duration: parseDuration(d.duration),
      });
    }
    setD(EMPTY_ENTRY);
    titleRef.current?.focus();
  };
  const addBreak = (kind) => {
    onAddBreak(kind, d.title.trim(), parseDuration(d.duration));
    setD(EMPTY_ENTRY);
  };

  return (
    <form className="se-quick" onSubmit={submit}>
      <span className="se-num">{String(nextNumber).padStart(2, '0')}</span>
      <input
        ref={titleRef}
        className="input grow"
        placeholder="Nuovo brano o dalla libreria: titolo e Invio…"
        list="se-library"
        value={d.title}
        onChange={set('title')}
      />
      {fromLibrary && (
        <span className="small muted" title="Viene aggiunto il brano della libreria, con tracce e video">
          <Icon name="layers" size={12} /> dalla libreria
        </span>
      )}
      <select className="select" value={d.playback} onChange={set('playback')} title="Tipo di esecuzione">
        <option value="">Tipo…</option>
        {Object.entries(PLAYBACK_TYPES).map(([k, v]) => (
          <option key={k} value={k}>
            {v.label}
          </option>
        ))}
      </select>
      <input className="input se-short" placeholder="Key" list="se-keys" value={d.key} onChange={set('key')} />
      <input
        className="input se-short"
        placeholder="BPM"
        inputMode="numeric"
        value={d.bpm}
        onChange={(e) => setD((x) => ({ ...x, bpm: e.target.value.replace(/\D/g, '').slice(0, 3) }))}
      />
      <input className="input se-short" placeholder="4:15" value={d.duration} onChange={set('duration')} title="Durata (min:sec)" />
      <button className="btn btn-sm btn-primary" disabled={!d.title.trim()}>
        <Icon name="plus" size={13} /> Brano
      </button>
      <span className="t-sep" style={{ height: 18 }} />
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => addBreak('pause')} title="Il testo e la durata scritti a sinistra vanno nel blocco">
        <Icon name="coffee" size={13} /> Pausa
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => addBreak('speech')} title="Il testo e la durata scritti a sinistra vanno nel blocco">
        <Icon name="mic" size={13} /> Discorso
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => addBreak('section')} title="Il testo scritto a sinistra diventa il nome del separatore">
        <Icon name="minus" size={13} /> Separatore
      </button>
      {endTime && <span className="small muted">Fine prevista {formatClock(endTime)}</span>}
      <datalist id="se-library">
        {(library || []).map((s) => (
          <option key={s.id} value={s.title}>
            {[s.artist, s.key].filter(Boolean).join(' · ')}
          </option>
        ))}
      </datalist>
      <datalist id="se-keys">
        {KEYS.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
    </form>
  );
}

// ---------- Song form tabs ----------
function SongFields({ d, set, setDraft }) {
  return (
    <div className="se-form">
      <label className="field">
        <span>Titolo</span>
        <input className="input" value={d.title} onChange={set('title')} />
      </label>
      <label className="field">
        <span>Artista / versione</span>
        <input className="input" value={d.artist} onChange={set('artist')} placeholder="Es. Hillsong · Versione live 2026" />
      </label>
      <div className="field">
        <span>Tipo di esecuzione</span>
        <div className="view-switch">
          {Object.entries(PLAYBACK_TYPES).map(([k, v]) => (
            <button
              key={k}
              type="button"
              className={d.playback === k ? 'is-on' : ''}
              onClick={() => setDraft((x) => ({ ...x, playback: x.playback === k ? '' : k }))}
              title={v.hint}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div className="se-grid">
        <label className="field">
          <span>Tonalità</span>
          <input className="input" value={d.key} onChange={set('key')} list="se-keys" placeholder="Es. G, Em" />
        </label>
        <label className="field">
          <span>BPM</span>
          <input className="input" inputMode="numeric" value={d.bpm} onChange={set('bpm')} placeholder="120" />
        </label>
        <label className="field">
          <span>Metro</span>
          <select className="select" value={d.timeSig} onChange={set('timeSig')}>
            <option value="">—</option>
            {TIME_SIGNATURES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Durata</span>
          <input className="input" value={d.duration} onChange={set('duration')} placeholder="4:15" />
        </label>
      </div>
      <label className="field">
        <span>Genere</span>
        <input className="input" value={d.genre} onChange={set('genre')} placeholder="Es. Rock, Ballad, Worship" />
      </label>
    </div>
  );
}

function StageFields({ d, set, setDraft }) {
  const setSection = (i, k, v) => setDraft((x) => ({ ...x, sections: x.sections.map((s, j) => (j === i ? { ...s, [k]: v } : s)) }));
  return (
    <div className="se-form">
      <div className="se-grid">
        <label className="field">
          <span>Modalità click</span>
          <select className="select" value={d.clickMode} onChange={set('clickMode')}>
            <option value="">—</option>
            {Object.entries(CLICK_MODES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Note per il batterista / attacco</span>
        <textarea className="input" rows={3} value={d.drumNotes} onChange={set('drumNotes')} placeholder="Es. Entrata chitarra acustica al beat 1." />
      </label>
      <div className="field">
        <span>Cambi di tempo (click programmabile)</span>
        <p className="small muted" style={{ margin: 0 }}>
          Sezioni suonate in ordine dopo il count-in; l’ultima si ripete. Vuoto = tempo unico ({d.bpm || '—'} BPM, {d.timeSig || '4/4'}).
        </p>
        {d.sections.map((s, i) => (
          <div key={i} className="se-line">
            <input className="input grow" value={s.label || ''} onChange={(e) => setSection(i, 'label', e.target.value)} placeholder="Strofa" />
            <input className="input se-short" inputMode="numeric" value={s.bars || ''} onChange={(e) => setSection(i, 'bars', e.target.value)} placeholder="Batt." />
            <input className="input se-short" inputMode="numeric" value={s.bpm || ''} onChange={(e) => setSection(i, 'bpm', e.target.value)} placeholder="BPM" />
            <select className="select" value={s.timeSig || ''} onChange={(e) => setSection(i, 'timeSig', e.target.value)}>
              <option value="">Metro</option>
              {TIME_SIGNATURES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button type="button" className="toggle" onClick={() => setDraft((x) => ({ ...x, sections: x.sections.filter((_, j) => j !== i) }))} title="Rimuovi sezione">
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-sm se-start"
          onClick={() => setDraft((x) => ({ ...x, sections: [...x.sections, { label: '', bars: 8, bpm: x.bpm, timeSig: x.timeSig || '4/4' }] }))}
        >
          <Icon name="plus" size={13} /> Aggiungi sezione
        </button>
      </div>
    </div>
  );
}

function ChartFields({ d, set }) {
  return (
    <div className="se-form se-fill">
      <label className="field">
        <span>Link spartito (PDF, Drive…)</span>
        <input className="input" type="url" value={d.chartUrl} onChange={set('chartUrl')} placeholder="https://…" />
      </label>
      <label className="field se-fill">
        <span>Testo e accordi (ChordPro o accordi sopra il testo)</span>
        <textarea
          className="input mono se-fill"
          value={d.chart}
          onChange={set('chart')}
          spellCheck={false}
          placeholder={'{soc}\n[G]Vedo il Re della [Em]gloria\n{eoc}'}
        />
      </label>
    </div>
  );
}

function LyricsFields({ d, set, setDraft, onOpenPrompter }) {
  const fromChart = d.chart.trim() ? chartLyricBlocks(d.chart) : [];
  const blocks = d.lyrics.trim() ? plainLyricBlocks(d.lyrics) : fromChart;
  const importChart = () => {
    if (d.lyrics.trim() && !confirm('Sostituire il testo con quello ricavato dagli accordi?')) return;
    setDraft((x) => ({ ...x, lyrics: lyricBlocksText(fromChart) }));
  };
  return (
    <div className="se-form se-fill">
      <p className="small muted" style={{ margin: 0 }}>
        Il testo da cui il Gobbo ricava le slide. Separa i blocchi con una riga vuota; una riga tra parentesi quadre
        (<span className="mono">[Ritornello]</span>) dà il nome al blocco. Vuoto: si usa il testo degli accordi.
      </p>
      <div className="field se-fill">
        <span className="se-field-head">
          Testo · {blocks.length} {blocks.length === 1 ? 'blocco' : 'blocchi'}
          {!d.lyrics.trim() && fromChart.length > 0 && <em className="faint"> (dagli accordi)</em>}
          <span className="grow" />
          {fromChart.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={importChart}>
              <Icon name="file-text" size={13} /> Importa dagli accordi
            </button>
          )}
          {onOpenPrompter && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenPrompter} title="Vai al Gobbo per creare slide e tempi">
              <Icon name="lyrics" size={13} /> Apri nel Gobbo
            </button>
          )}
        </span>
        <textarea
          className="input se-fill se-lyrics"
          value={d.lyrics}
          onChange={set('lyrics')}
          placeholder={'[Strofa 1]\nVedo il Re della gloria\nSale sul trono\n\n[Ritornello]\nOsanna, osanna'}
        />
      </div>
    </div>
  );
}

function MidiFields({ d, setDraft }) {
  const setPatch = (i, k, v) => setDraft((x) => ({ ...x, midi: x.midi.map((p, j) => (j === i ? { ...p, [k]: v } : p)) }));
  return (
    <div className="se-form">
      <p className="small muted" style={{ margin: 0 }}>
        Bank Select e Program Change inviati dall’app web ai dispositivi con l’invio MIDI attivo.
      </p>
      {d.midi.map((p, i) => (
        <div key={i} className="se-line">
          <input className="input grow" value={p.label || ''} onChange={(e) => setPatch(i, 'label', e.target.value)} placeholder="Strumento" />
          <input className="input grow" value={p.name || ''} onChange={(e) => setPatch(i, 'name', e.target.value)} placeholder="Nome patch" />
          <input className="input se-tiny" value={p.channel ?? ''} onChange={(e) => setPatch(i, 'channel', e.target.value)} placeholder="Ch" title="Canale" />
          <input className="input se-tiny" value={p.program ?? ''} onChange={(e) => setPatch(i, 'program', e.target.value)} placeholder="PC" title="Program Change (1-128)" />
          <input className="input se-tiny" value={p.bankMsb ?? ''} onChange={(e) => setPatch(i, 'bankMsb', e.target.value)} placeholder="MSB" title="Bank MSB" />
          <input className="input se-tiny" value={p.bankLsb ?? ''} onChange={(e) => setPatch(i, 'bankLsb', e.target.value)} placeholder="LSB" title="Bank LSB" />
          <button type="button" className="toggle" onClick={() => setDraft((x) => ({ ...x, midi: x.midi.filter((_, j) => j !== i) }))} title="Rimuovi patch">
            <Icon name="x" size={11} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-sm se-start"
        onClick={() => setDraft((x) => ({ ...x, midi: [...x.midi, { label: '', name: '', channel: x.midi.length + 1, program: '' }] }))}
      >
        <Icon name="plus" size={13} /> Aggiungi strumento
      </button>
    </div>
  );
}

function ColumnFields({ d, setDraft, columns }) {
  const setValue = (id, v) => setDraft((x) => ({ ...x, values: { ...x.values, [id]: v } }));
  if (!columns.length) return <p className="pr-note">Nessuna colonna personalizzata: si aggiungono dall’app web (Colonne).</p>;
  return (
    <div className="se-form">
      {columns.map((c) => {
        const v = d.values[c.id];
        let input;
        if (c.type === 'checkbox' || c.type === 'toggle') {
          const [a, b] = c.type === 'checkbox' ? ['NO', 'SÌ'] : toggleOptions(c);
          input = (
            <div className="view-switch">
              <button type="button" className={!v ? 'is-on' : ''} onClick={() => setValue(c.id, false)}>
                {a}
              </button>
              <button type="button" className={v ? 'is-on' : ''} onClick={() => setValue(c.id, true)}>
                {b}
              </button>
            </div>
          );
        } else if (c.type === 'select') {
          input = (
            <select className="select" value={v || ''} onChange={(e) => setValue(c.id, e.target.value || null)}>
              <option value="">—</option>
              {selectChoices(c).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          );
        } else if (c.type === 'note') {
          input = <textarea className="input" rows={4} value={v || ''} onChange={(e) => setValue(c.id, e.target.value)} />;
        } else {
          input = (
            <input className="input" type={c.type === 'url' ? 'url' : 'text'} value={v || ''} onChange={(e) => setValue(c.id, e.target.value)} />
          );
        }
        return (
          <div className="field" key={c.id}>
            <span>
              {c.name} {!c.visible && <em className="faint">(solo nel dettaglio)</em>}
            </span>
            {input}
          </div>
        );
      })}
    </div>
  );
}

// ---------- Inspector of a song: draft saved with Salva, Ctrl+S or when leaving it ----------
// Also used by the Brani page for the songs of the library (library: no number, no columns).
export function SongInspector({ setlistId, item, number, columns, canEdit, canDelete = canEdit, library = false, onSave, onDelete, onOpenPrompter, onTrack, notify }) {
  const [draft, setDraft] = useState(() => itemDraft(item));
  const [tab, setTab] = useState('song');
  const dirty = canEdit && !draftUnchanged(draft, item);
  const set = (k) => (e) => setDraft((x) => ({ ...x, [k]: e.target.value }));

  const latest = useRef();
  latest.current = { draft, item, dirty, onSave };
  const save = useCallback(() => {
    const l = latest.current;
    if (l.dirty) l.onSave(l.item, itemFromDraft(l.draft, l.item));
  }, []);

  // Changes are not lost when selecting another song or leaving the page.
  useEffect(() => save, [save]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const media = stemsOf(item).length + (videoOf(item) ? 1 : 0) + (item.score?.path ? 1 : 0);

  return (
    <aside className="se-inspector">
      <div className="panel-head">
        {library ? 'Brano in libreria' : `Brano #${String(number).padStart(2, '0')}`}
        {dirty && <span className="tag tag-play-backing">Modificato</span>}
      </div>
      <div className="se-tabs" role="tablist">
        {TABS.filter(([k]) => !library || k !== 'columns').map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>
            {label}
            {k === 'midi' && draft.midi.length > 0 && <span className="se-count">{draft.midi.length}</span>}
            {k === 'lyrics' && draft.lyrics.trim() && <span className="se-dot" />}
            {k === 'media' && media > 0 && <span className="se-count">{media}</span>}
          </button>
        ))}
      </div>
      <fieldset className="se-body-scroll" disabled={!canEdit}>
        {tab === 'song' && <SongFields d={draft} set={set} setDraft={setDraft} />}
        {tab === 'stage' && <StageFields d={draft} set={set} setDraft={setDraft} />}
        {tab === 'chart' && <ChartFields d={draft} set={set} />}
        {tab === 'lyrics' && <LyricsFields d={draft} set={set} setDraft={setDraft} onOpenPrompter={onOpenPrompter} />}
        {tab === 'midi' && <MidiFields d={draft} setDraft={setDraft} />}
        {tab === 'columns' && <ColumnFields d={draft} setDraft={setDraft} columns={columns} />}
        {tab === 'media' && <MediaFields setlistId={setlistId} item={item} canEdit={canEdit} onTrack={onTrack} notify={notify} />}
      </fieldset>
      {canEdit && (
        <div className="se-foot">
          {canDelete && (
            <button className="btn btn-sm btn-ghost se-danger" onClick={() => onDelete(item)}>
              <Icon name="trash" size={13} /> Elimina
            </button>
          )}
          <span className="grow" />
          <button className="btn btn-sm" disabled={!dirty} onClick={() => setDraft(itemDraft(item))}>
            Annulla
          </button>
          <button className="btn btn-sm btn-primary" disabled={!dirty} onClick={save} title="Salva (Ctrl+S)">
            Salva
          </button>
        </div>
      )}
    </aside>
  );
}

function BreakInspector({ item, canEdit, onSave, onDelete }) {
  const [title, setTitle] = useState(item.title || '');
  const [kind, setKind] = useState(item.kind || 'section');
  const [duration, setDuration] = useState(item.duration ? formatDuration(item.duration) : '');
  const data = { title: title.trim() || BREAK_KINDS[kind].label, kind, duration: parseDuration(duration) };
  const dirty =
    canEdit && (data.title !== item.title || data.kind !== (item.kind || 'section') || (data.duration ?? null) !== (item.duration ?? null));

  const latest = useRef();
  latest.current = { data, dirty, item, onSave };
  const save = useCallback(() => {
    const l = latest.current;
    if (l.dirty) l.onSave(l.item, l.data);
  }, []);
  useEffect(() => save, [save]);

  return (
    <aside className="se-inspector">
      <div className="panel-head">
        Blocco della scaletta
        {dirty && <span className="tag tag-play-backing">Modificato</span>}
      </div>
      <fieldset className="se-body-scroll" disabled={!canEdit}>
        <form
          className="se-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="view-switch">
            {Object.entries(BREAK_KINDS).map(([k, v]) => (
              <button key={k} type="button" className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)}>
                <Icon name={v.icon} size={13} /> {v.label}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Testo</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={BREAK_KINDS[kind].label} />
          </label>
          <label className="field">
            <span>Durata (conta nel totale del set)</span>
            <input className="input" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="Es. 3:00" />
          </label>
        </form>
      </fieldset>
      {canEdit && (
        <div className="se-foot">
          <button className="btn btn-sm btn-ghost se-danger" onClick={() => onDelete(item)}>
            <Icon name="trash" size={13} /> Elimina
          </button>
          <span className="grow" />
          <button className="btn btn-sm btn-primary" disabled={!dirty} onClick={save}>
            Salva
          </button>
        </div>
      )}
    </aside>
  );
}

function TitleEditor({ setlist, canEdit, onRename }) {
  const [title, setTitle] = useState(setlist.title || '');
  useEffect(() => setTitle(setlist.title || ''), [setlist.title]);
  const commit = () => {
    const t = title.trim();
    if (t && t !== setlist.title) onRename(t);
    else setTitle(setlist.title || '');
  };
  return (
    <input
      className="se-title"
      value={title}
      disabled={!canEdit}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      aria-label="Titolo scaletta"
    />
  );
}

export default function SetlistEditor({ user, setlist, items, itemDocs, numbers, canEdit, selectedId, onSelect, onOpenPrompter, notify }) {
  const [editId, setEditId] = useState(selectedId);
  const [drag, setDrag] = useState(null); // { from, before }
  const listRef = useRef(null);
  const deleting = useRef(new Set()); // no late save of a song being deleted
  const setlistId = setlist.id;
  const { canCreate: canCreateSongs } = useAccess(user);
  const { all: library } = useLibrary(user.uid, (user.email || '').toLowerCase());

  // The song selected in the other pages is the one edited here.
  useEffect(() => {
    if (selectedId) setEditId(selectedId);
  }, [selectedId]);

  // Song count and duration are kept on the setlist for the lists (as on the web).
  useEffect(() => {
    if (!canEdit) return undefined;
    const st = setlistStats(items);
    if (st.songs === setlist.stats?.songs && st.duration === setlist.stats?.duration) return undefined;
    const t = setTimeout(() => updateDoc(doc(db, 'setlists', setlistId), { stats: st }).catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, [canEdit, items, setlist.stats, setlistId]);

  const editing = items.find((it) => it.id === editId) || null;
  const songs = items.filter((it) => !isSeparator(it));
  const columns = setlist.columns || [];
  const tableCols = columns.filter((c) => c.visible && c.type !== 'note');
  const total = totalDuration(items);
  const endTime = expectedEnd(setlist, items);
  const itemRef = (id) => doc(db, 'setlists', setlistId, 'items', id);
  const touch = () => updateDoc(doc(db, 'setlists', setlistId), { updatedAt: serverTimestamp() }).catch(() => {});

  const select = (it) => {
    setEditId(it.id);
    if (!isSeparator(it)) onSelect(it.id);
  };

  const safely = async (fn) => {
    try {
      await fn();
    } catch (e) {
      notify(`Scaletta non aggiornata: ${e.message}`, true);
    }
  };

  // Every content change goes to the setlist history, as on the web app.
  const track = (text) => {
    autoSnapshot(setlist, itemDocs, user);
    logChange(setlistId, user, text);
  };

  const createItem = (data, type) =>
    safely(async () => {
      const order = items.reduce((m, i) => Math.max(m, i.order ?? 0), -1) + 1;
      track(type === 'separator' ? `Aggiunto il blocco “${data.title}”` : `Aggiunto “${data.title}”`);
      // A new song also goes to the library ("Brani"), where its media live.
      let songId = data.songId || null;
      if (type === 'song' && !songId && canCreateSongs) {
        const song = createSong(user, data);
        song.done.catch((e) => console.warn('Brano non salvato nella libreria', e));
        songId = song.id;
      }
      await addDoc(collection(db, 'setlists', setlistId, 'items'), {
        ...data,
        ...(songId && { songId }),
        type,
        order,
        values: {},
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      touch();
      notify(`Aggiunto “${data.title}”`);
    });

  const addBreak = (kind, title, duration) =>
    createItem({ title: title || BREAK_KINDS[kind].label, kind, duration: duration ?? (kind === 'section' ? null : 180) }, 'separator');

  const saveItem = (item, data) =>
    !deleting.current.has(item.id) &&
    safely(async () => {
      track(isSeparator(item) ? `Modificato il blocco “${data.title}”` : `Modificato “${data.title || item.title}”`);
      await updateDoc(itemRef(item.id), { ...data, updatedAt: serverTimestamp() });
      // The library song follows the latest edit, ready for the next setlists.
      if (!isSeparator(item) && item.songId && item.songEditable) updateSong(item.songId, data).catch(() => {});
      notify(`Salvato “${data.title || item.title}”`);
    });

  const setValue = (item, col, value) =>
    safely(async () => {
      track(`“${item.title}”: ${col.name} cambiato`);
      await updateDoc(itemRef(item.id), { [`values.${col.id}`]: value, updatedAt: serverTimestamp() });
    });

  const reorder = (from, to) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    safely(async () => {
      track(`Spostato “${moved.title}” in posizione #${to + 1}`);
      const b = writeBatch(db);
      next.forEach((it, i) => {
        if (it.order !== i) b.update(itemRef(it.id), { order: i });
      });
      await b.commit();
      touch();
    });
  };

  const removeItem = (item) => {
    const note = item.songId
      ? ' Il brano resta nella libreria Brani con le sue tracce: per cancellarle eliminalo da lì.'
      : stemsOf(item).length || videoOf(item)
        ? ' Verranno eliminati anche tracce e video dallo storage.'
        : '';
    if (!confirm(`Eliminare “${item.title}” dalla scaletta?${note}`)) return;
    deleting.current.add(item.id);
    if (item.id === editId) setEditId(null);
    safely(async () => {
      track(`Eliminato “${item.title}”`);
      await deleteDoc(itemRef(item.id));
      deleteItemMedia(storage, setlistId, item);
    });
  };

  const rename = (title) =>
    safely(async () => {
      track(`Rinominata in “${title}”`);
      await updateDoc(doc(db, 'setlists', setlistId), { title, updatedAt: serverTimestamp() });
    });

  // Reorder by dragging the grip (pointer events, so the row follows only the grip).
  const startDrag = (e, from) => {
    if (!canEdit || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const beforeAt = (y) => {
      const rows = [...listRef.current.querySelectorAll('[data-row]')];
      const k = rows.findIndex((r) => {
        const b = r.getBoundingClientRect();
        return y < b.top + b.height / 2;
      });
      return k < 0 ? rows.length : k;
    };
    const move = (ev) => setDrag({ from, before: beforeAt(ev.clientY) });
    const up = (ev) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      setDrag(null);
      const before = beforeAt(ev.clientY);
      reorder(from, before > from ? before - 1 : before);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    setDrag({ from, before: from });
  };

  // ↑ / ↓ move the selection in the list.
  const keys = useRef();
  keys.current = { items, editId, select };
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const k = keys.current;
      const i = k.items.findIndex((it) => it.id === k.editId);
      const next = k.items[e.key === 'ArrowDown' ? i + 1 : Math.max(0, i - 1)];
      if (next) k.select(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const grid = { gridTemplateColumns: `52px minmax(180px, 1fr) 64px 84px 56px ${tableCols.map(() => 'minmax(70px, 120px)').join(' ')} ${canEdit ? '76px' : ''}` };
  const dropClass = (i) => {
    if (!drag || drag.before === drag.from || drag.before === drag.from + 1) return '';
    if (drag.before === i) return 'drop-before';
    return drag.before === items.length && i === items.length - 1 ? 'drop-after' : '';
  };

  return (
    <div className="setlist-editor">
      <div className="arr-toolbar">
        <Icon name="list-music" size={15} />
        <TitleEditor setlist={setlist} canEdit={canEdit} onRename={rename} />
        <span className="small muted">
          {songs.length} brani{total > 0 && ` · ${formatLong(total)}`}
          {endTime && ` · fine prevista ${formatClock(endTime)}`}
        </span>
        {!canEdit && <span className="tag">Sola lettura</span>}
        <span className="grow" />
        <span className="small faint">Colonne e condivisione: app web</span>
      </div>

      <div className="se-main">
        <div className="se-list-wrap">
          <div className="se-list" ref={listRef}>
            <div className="se-row se-head" style={grid}>
              <span>#</span>
              <span>Titolo & esecuzione</span>
              <span>Tonalità</span>
              <span>BPM / Metro</span>
              <span>Durata</span>
              {tableCols.map((c) => (
                <span key={c.id} className="ellipsis">
                  {c.name}
                </span>
              ))}
              {canEdit && <span />}
            </div>
            {items.map((it, i) => {
              const sep = isSeparator(it);
              const cls = `se-row ${sep ? 'is-sep' : ''} ${it.id === editId ? 'is-selected' : ''} ${drag?.from === i ? 'is-dragging' : ''} ${dropClass(i)}`;
              const actions = canEdit && (
                <span className="se-actions">
                  <button className="toggle" disabled={i === 0} onClick={(e) => (e.stopPropagation(), reorder(i, i - 1))} title="Sposta su">
                    <Icon name="chevron-up" size={11} />
                  </button>
                  <button className="toggle" disabled={i === items.length - 1} onClick={(e) => (e.stopPropagation(), reorder(i, i + 1))} title="Sposta giù">
                    <Icon name="chevron-down" size={11} />
                  </button>
                  <button className="toggle" onClick={(e) => (e.stopPropagation(), removeItem(it))} title="Elimina">
                    <Icon name="x" size={11} />
                  </button>
                </span>
              );
              const lead = (
                <span className="se-lead">
                  {canEdit && (
                    <span className="se-grip" onPointerDown={(e) => startDrag(e, i)} title="Trascina per riordinare">
                      <Icon name="grip" size={13} />
                    </span>
                  )}
                  {!sep && <span className="se-num">{String(numbers[it.id]).padStart(2, '0')}</span>}
                </span>
              );
              if (sep) {
                return (
                  <div key={it.id} data-row className={cls} style={grid} onClick={() => select(it)}>
                    {lead}
                    <span className="se-break" style={{ gridColumn: `2 / ${canEdit ? -2 : -1}` }}>
                      <Icon name={BREAK_KINDS[it.kind || 'section']?.icon || 'minus'} size={13} />
                      <span className="ellipsis">{it.title}</span>
                      {it.duration > 0 && <span className="small faint">{formatDuration(it.duration)} min</span>}
                    </span>
                    {actions}
                  </div>
                );
              }
              return (
                <div key={it.id} data-row className={cls} style={grid} onClick={() => select(it)}>
                  {lead}
                  <span className="se-title-cell">
                    <span className="ellipsis se-song-title">{it.title}</span>
                    <span className="se-sub">
                      {it.playback && <span className={`tag tag-play-${it.playback}`}>{PLAYBACK_TYPES[it.playback]?.label}</span>}
                      {it.artist && <span className="ellipsis">{it.artist}</span>}
                      {it.chart && <span className="tag">Accordi</span>}
                      {(it.lyrics || '').trim() && <span className="tag">Testo</span>}
                      {it.prompter?.slides?.length > 0 && <span className="tag">Gobbo</span>}
                    </span>
                  </span>
                  <span className="se-key">{it.key || ''}</span>
                  <span className="small">
                    {it.bpm && <b className="mono">{it.bpm}</b>} <span className="faint">{it.timeSig || ''}</span>
                  </span>
                  <span className="mono small">{formatDuration(it.duration)}</span>
                  {tableCols.map((c) => (
                    <span key={c.id} className="se-cell" onClick={(e) => e.stopPropagation()}>
                      <Cell column={c} value={it.values?.[c.id]} canEdit={canEdit} onSet={(v) => setValue(it, c, v)} />
                    </span>
                  ))}
                  {actions}
                </div>
              );
            })}
            {!items.length && <p className="pr-note">La scaletta è vuota.{canEdit && ' Aggiungi il primo brano qui sotto.'}</p>}
          </div>
          {canEdit && (
            <QuickEntry
              nextNumber={songs.length + 1}
              endTime={endTime}
              library={library}
              onAddSong={(d) => createItem(d, 'song')}
              onAddFromLibrary={(song) => createItem(itemFromSong(song), 'song')}
              onAddBreak={addBreak}
            />
          )}
        </div>

        {!editing ? (
          <aside className="se-inspector">
            <div className="empty">Seleziona un brano o un blocco della scaletta.</div>
          </aside>
        ) : isSeparator(editing) ? (
          <BreakInspector key={editing.id} item={editing} canEdit={canEdit} onSave={saveItem} onDelete={removeItem} />
        ) : (
          <SongInspector
            key={editing.id}
            setlistId={setlistId}
            onTrack={track}
            notify={notify}
            item={editing}
            number={numbers[editing.id]}
            columns={columns}
            canEdit={canEdit}
            onSave={saveItem}
            onDelete={removeItem}
            onOpenPrompter={() => onOpenPrompter(editing.id)}
          />
        )}
      </div>
    </div>
  );
}
