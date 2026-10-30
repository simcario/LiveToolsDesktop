import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { newId } from '../shared/setlists.js';
import { hasOwnLyrics } from '../shared/music.js';
import { engineStatus, livePosition, useEngineStatus } from '../lib/engine';
import { db } from '../lib/firebase';
import {
  autoPrompter,
  compactCues,
  cueIndexAt,
  insertCue,
  punch,
  setPrompterOverride,
  SLIDE_COLORS,
  slideColor,
  slideName,
  songLyricsText,
  usePrompterData,
} from '../lib/prompter';
import Icon from './Icon';
import SlideText from './SlideText';

const LEADS = [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1];
const SPLITS = [
  [2, '2 righe'],
  [3, '3 righe'],
  [4, '4 righe'],
  [6, '6 righe'],
  [0, 'Blocchi interi'],
];

function fmt(t) {
  const neg = t < 0;
  const s = Math.abs(t);
  return `${neg ? '-' : ''}${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}

// ---------- Song text: slides from a selection; the lyrics can be written here ----------
function SourceText({ text, ownLyrics, canEdit, onCreate, onSave }) {
  const [draft, setDraft] = useState(null); // null = not editing
  const save = () => {
    onSave(draft);
    setDraft(null);
  };
  const fromSelection = () => {
    const sel = window
      .getSelection()
      .toString()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^\[.*\]$/.test(l));
    if (sel.length) onCreate(sel.join('\n'));
  };
  return (
    <div className="pr-col pr-source">
      <div className="panel-head">
        Testo del brano
        {text && draft === null && (
          <span className="tag" title={ownLyrics ? 'Campo “Testo gobbo” del brano' : 'Ricavato dagli accordi del brano'}>
            {ownLyrics ? 'Testo gobbo' : 'Dagli accordi'}
          </span>
        )}
        <span className="grow" />
        {draft !== null ? (
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setDraft(null)}>
              Annulla
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={save}
              title="Salva nel campo “Testo gobbo” del brano (Ctrl+S)"
            >
              Salva
            </button>
          </>
        ) : (
          canEdit && (
            <button
              className="btn btn-ghost btn-sm btn-icon"
              onClick={() => setDraft(text)}
              title={text ? 'Modifica il testo' : 'Scrivi il testo'}
            >
              <Icon name="edit" size={13} />
            </button>
          )
        )}
        {canEdit && text && draft === null && (
          <button
            className="btn btn-ghost btn-sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={fromSelection}
            title="Seleziona alcune righe del testo e crea una slide"
          >
            <Icon name="plus" size={13} /> Dalla selezione
          </button>
        )}
      </div>
      {draft !== null ? (
        <textarea
          className="pr-source-text pr-source-edit"
          value={draft}
          autoFocus
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') setDraft(null);
          }}
          placeholder={'[Strofa 1]\nVedo il Re della gloria\nSale sul trono\n\n[Ritornello]\nOsanna, osanna\n\nRiga vuota = nuovo blocco, [Nome] = nome del blocco.'}
        />
      ) : text ? (
        <pre className="pr-source-text">{text}</pre>
      ) : (
        <p className="pr-note">
          Il brano non ha un testo. Premi la matita per scriverlo: riga vuota = nuovo blocco, una riga tra parentesi
          quadre (<span className="mono">[Ritornello]</span>) dà il nome al blocco.
        </p>
      )}
    </div>
  );
}

// ---------- One slide in the editor ----------
function SlideCard({ slide, index, count, uses, canEdit, onChange, onSplit, onMerge, onMove, onDelete }) {
  const area = useRef(null);
  return (
    <div className="pr-slide" style={{ '--slide-color': SLIDE_COLORS[index % SLIDE_COLORS.length] }}>
      <div className="pr-slide-head">
        <span className="pr-badge">{index < 9 ? index + 1 : '·'}</span>
        <input
          className="pr-label"
          value={slide.label || ''}
          placeholder={`Slide ${index + 1}`}
          disabled={!canEdit}
          onChange={(e) => onChange({ label: e.target.value })}
        />
        <span className="small faint" title="Cambi registrati su questa slide">
          {uses ? `${uses}×` : ''}
        </span>
        {canEdit && (
          <span className="pr-slide-tools">
            <button className="toggle" disabled={index === 0} onClick={() => onMove(-1)} title="Sposta su">
              <Icon name="chevron-up" size={12} />
            </button>
            <button className="toggle" disabled={index === count - 1} onClick={() => onMove(1)} title="Sposta giù">
              <Icon name="chevron-down" size={12} />
            </button>
            <button
              className="toggle"
              onClick={() => onSplit(area.current?.selectionStart ?? 0)}
              title="Dividi la slide alla posizione del cursore"
            >
              <Icon name="scissors" size={12} />
            </button>
            <button className="toggle" disabled={index === count - 1} onClick={onMerge} title="Unisci con la slide successiva">
              <Icon name="merge" size={12} />
            </button>
            <button className="toggle" onClick={onDelete} title="Elimina la slide">
              <Icon name="trash" size={12} />
            </button>
          </span>
        )}
      </div>
      <textarea
        ref={area}
        className="pr-text"
        value={slide.text}
        rows={Math.max(2, slide.text.split('\n').length)}
        disabled={!canEdit}
        onChange={(e) => onChange({ text: e.target.value })}
        spellCheck={false}
      />
    </div>
  );
}

// ---------- Timeline of the slide changes ----------
function CueTimeline({ cues, slides, tempo, duration, editable, onLocate, onMoveCue }) {
  const box = useRef(null);
  const head = useRef(null);
  const [width, setWidth] = useState(600);
  const [drag, setDrag] = useState(null); // { i, t }
  const t0 = Math.min(0, -(tempo?.preRoll || 0));
  const t1 = Math.max(duration || 0, (cues.at(-1)?.t || 0) + 5, 10);
  const pps = width / (t1 - t0);
  const x = (t) => (t - t0) * pps;
  const tAt = (clientX) => (clientX - box.current.getBoundingClientRect().left) / pps + t0;

  useLayoutEffect(() => {
    const el = box.current;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let raf;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (head.current) head.current.style.transform = `translateX(${x(livePosition())}px)`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  const shown = drag ? cues.map((c, i) => (i === drag.i ? { ...c, t: drag.t } : c)) : cues;

  const startDrag = (e, i) => {
    if (!editable) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const lo = (cues[i - 1]?.t ?? -Infinity) + 0.05;
    const hi = (cues[i + 1]?.t ?? Infinity) - 0.05;
    const clamp = (t) => Math.max(lo, Math.min(hi, t));
    const move = (ev) => setDrag({ i, t: clamp(tAt(ev.clientX)) });
    const up = (ev) => {
      ev.target.removeEventListener('pointermove', move);
      ev.target.removeEventListener('pointerup', up);
      setDrag(null);
      onMoveCue(i, clamp(tAt(ev.clientX)));
    };
    e.currentTarget.addEventListener('pointermove', move);
    e.currentTarget.addEventListener('pointerup', up);
    setDrag({ i, t: cues[i].t });
  };

  return (
    <div className="pr-timeline" ref={box} onMouseDown={(e) => onLocate(tAt(e.clientX))}>
      {(tempo?.segments || [])
        .filter((s) => s.label && !s.countIn)
        .map((s, i) => (
          <span key={i} className="pr-section" style={{ left: x(s.start) }}>
            {s.label}
          </span>
        ))}
      {shown.map((c, i) => {
        const end = shown[i + 1]?.t ?? t1;
        const color = slideColor(slides, c.slide);
        return (
          <div
            key={i}
            className={`pr-block ${c.slide ? '' : 'is-blank'}`}
            style={{ left: x(c.t), width: Math.max(1, (end - c.t) * pps), '--slide-color': color || 'transparent' }}
            title={`${fmt(c.t)} · ${slideName(slides, c.slide)}`}
          >
            <span className="pr-block-label">{slideName(slides, c.slide)}</span>
            <span className={`pr-handle ${editable ? 'is-drag' : ''}`} onPointerDown={(e) => startDrag(e, i)} />
          </div>
        );
      })}
      <div className="pr-zero" style={{ left: x(0) }} />
      <div className="arr-playhead pr-playhead" ref={head} />
    </div>
  );
}

export default function PrompterView({ item, setlistId, player, canEdit, settings, update, onOutput, notify }) {
  const [data, setData] = usePrompterData(setlistId, item, canEdit, notify);
  const [split, setSplit] = useState(4);
  const [armed, setArmed] = useState(false);
  const [takeCues, setTakeCues] = useState(null); // cues of the take being recorded
  const [seqPos, setSeqPos] = useState(0);
  const take = useRef(null); // { from, cues }
  const history = useRef([]);
  const isLoaded = !!item && player.loaded?.itemId === item.id;
  const playing = useEngineStatus((s) => s.playing && s.songId === item?.id);
  const now = useEngineStatus((s) => (takeCues && s.songId === item?.id ? Math.floor(s.position * 4) / 4 : 0));
  const { slides, order } = data;
  const lyricsSrc = item?.lyrics;
  const chartSrc = item?.chart;
  const lyrics = useMemo(() => songLyricsText({ lyrics: lyricsSrc, chart: chartSrc }), [lyricsSrc, chartSrc]);
  const takeFrom = take.current?.from;
  const cues = useMemo(
    () => (takeCues ? punch(data.cues, takeCues, takeFrom, now) : data.cues),
    [data.cues, takeCues, takeFrom, now],
  );
  const lead = settings.prompterLead || 0;
  const current = useEngineStatus((s) => (s.songId === item?.id ? cueIndexAt(cues, s.position + lead) : -1));

  // Undoable change (slides and cues; typing is not recorded).
  const change = useCallback(
    (fn) => {
      history.current = [...history.current.slice(-49), data];
      setData(fn);
    },
    [data, setData],
  );
  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (prev) setData(prev);
  }, [setData]);

  useEffect(() => {
    history.current = [];
    setArmed(false);
  }, [item?.id]);

  // The output window shows what is edited here, take included.
  useEffect(() => {
    setPrompterOverride(item ? { itemId: item.id, data: { slides, order, cues } } : null);
  }, [item, slides, order, cues]);
  useEffect(() => () => setPrompterOverride(null), []);

  // Recording: armed + playing = a take; stopping (or disarming) punches it in.
  useEffect(() => {
    if (armed && playing && !take.current) {
      const from = livePosition();
      take.current = { from, cues: [] };
      setTakeCues([]);
      setSeqPos(Math.min(order.length, data.cues.filter((c) => c.slide && c.t < from).length));
    } else if (take.current && (!armed || !playing)) {
      const { from, cues: tc } = take.current;
      const to = Math.max(engineStatus().position, tc.at(-1)?.t ?? from);
      take.current = null;
      setTakeCues(null);
      if (tc.length) change((d) => ({ ...d, cues: compactCues(punch(d.cues, tc, from, to)) }));
    }
  }, [armed, playing, order.length, data.cues, change]);

  const tap = useCallback(
    (slideId, seqIndex) => {
      if (!canEdit || !isLoaded) return;
      const cue = { t: Math.round(livePosition() * 1000) / 1000, slide: slideId };
      if (take.current) {
        take.current.cues = insertCue(take.current.cues, cue);
        setTakeCues(take.current.cues);
      } else {
        change((d) => ({ ...d, cues: insertCue(d.cues, cue) }));
      }
      setSeqPos((p) => {
        if (seqIndex !== undefined) return seqIndex + 1;
        const i = order.indexOf(slideId, p);
        return i >= 0 ? i + 1 : p;
      });
    },
    [canEdit, isLoaded, change, order],
  );

  const next = useCallback(() => {
    if (seqPos < order.length) tap(order[seqPos], seqPos);
  }, [seqPos, order, tap]);

  // Keys: 1–9 slide, 0 blank, Invio/↓ next in sequence (while recording), R arm, Ctrl+Z undo.
  const keys = useRef();
  keys.current = { slides, armed, tap, next, undo, canEdit, isLoaded };
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      const k = keys.current;
      if (!k.canEdit) return;
      let handled = true;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') k.undo();
      else if (e.ctrlKey || e.metaKey || e.altKey) handled = false;
      else if (e.key === '0') k.tap(null);
      else if (/^[1-9]$/.test(e.key) && k.slides[Number(e.key) - 1]) k.tap(k.slides[Number(e.key) - 1].id);
      else if (k.armed && (e.key === 'Enter' || e.key === 'ArrowDown')) k.next();
      else if ((e.key === 'r' || e.key === 'R') && k.isLoaded) setArmed((a) => !a);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ---------- Slide editing ----------
  const setSlide = (id, patch) => setData((d) => ({ ...d, slides: d.slides.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const addSlide = (text = '') => {
    const id = newId();
    change((d) => ({ ...d, slides: [...d.slides, { id, label: '', text }], order: [...d.order, id] }));
  };
  const moveSlide = (i, dir) =>
    change((d) => {
      const s = [...d.slides];
      [s[i], s[i + dir]] = [s[i + dir], s[i]];
      return { ...d, slides: s };
    });
  const splitSlide = (i, at) =>
    change((d) => {
      const s = d.slides[i];
      const a = s.text.slice(0, at).replace(/\s+$/, '');
      const b = s.text.slice(at).replace(/^\s+/, '');
      if (!a || !b) return d;
      const id = newId();
      return {
        ...d,
        slides: [...d.slides.slice(0, i), { ...s, text: a }, { id, label: s.label ? `${s.label} (2)` : '', text: b }, ...d.slides.slice(i + 1)],
        order: d.order.flatMap((x) => (x === s.id ? [x, id] : [x])),
      };
    });
  const mergeSlide = (i) =>
    change((d) => {
      const a = d.slides[i];
      const b = d.slides[i + 1];
      const order2 = d.order.map((x) => (x === b.id ? a.id : x)).filter((x, k, arr) => k === 0 || !(x === a.id && arr[k - 1] === a.id));
      return {
        ...d,
        slides: d.slides.filter((s) => s.id !== b.id).map((s) => (s.id === a.id ? { ...s, text: `${a.text}\n${b.text}` } : s)),
        order: order2,
        cues: compactCues(d.cues.map((c) => (c.slide === b.id ? { ...c, slide: a.id } : c))),
      };
    });
  const deleteSlide = (s) => {
    const used = data.cues.filter((c) => c.slide === s.id).length;
    if (used && !confirm(`“${slideName(slides, s.id)}” compare in ${used} cambi registrati, che verranno rimossi. Continuare?`)) return;
    change((d) => ({
      ...d,
      slides: d.slides.filter((x) => x.id !== s.id),
      order: d.order.filter((x) => x !== s.id),
      cues: compactCues(d.cues.filter((c) => c.slide !== s.id)),
    }));
  };
  // Lyrics written here go to the song's “Testo gobbo” field, as on the web app
  // (not awaited: offline the write waits for the network in the local cache).
  const saveLyrics = (text) => {
    updateDoc(doc(db, 'setlists', setlistId, 'items', item.id), { lyrics: text.trim() ? text : null, updatedAt: serverTimestamp() }).catch((e) =>
      notify(`Testo non salvato: ${e.message}`, true),
    );
    notify('Testo del brano salvato');
  };
  const generate = () => {
    if (slides.length && !confirm('Rigenerare le slide dal testo? Slide e cambi registrati attuali verranno sostituiti (Ctrl+Z per annullare).')) return;
    const next = autoPrompter(item, split);
    if (!next.slides.length) notify('Nessuna riga di testo trovata nel brano', true);
    else change(next);
  };

  // ---------- Cue editing ----------
  const editCue = (i, patch) =>
    change((d) => ({ ...d, cues: compactCues(d.cues.map((c, k) => (k === i ? { ...c, ...patch } : c)).sort((a, b) => a.t - b.t)) }));
  const deleteCue = (i) => change((d) => ({ ...d, cues: d.cues.filter((_, k) => k !== i) }));
  const clearCues = () => {
    if (confirm('Eliminare tutti i cambi registrati di questo brano?')) change((d) => ({ ...d, cues: [] }));
  };

  if (!item) {
    return (
      <div className="empty">
        <div>
          <Icon name="lyrics" size={36} />
          <h2>Gobbo</h2>
          <p>Seleziona un brano della scaletta.</p>
        </div>
      </div>
    );
  }

  const shown = current >= 0 ? cues[current] : null;
  const currentSlide = shown && slides.find((s) => s.id === shown.slide);
  const nextCue = cues.slice(current + 1).find((c) => c.slide);
  const nextSlide = nextCue && slides.find((s) => s.id === nextCue.slide);
  const uses = Object.fromEntries(slides.map((s) => [s.id, data.cues.filter((c) => c.slide === s.id).length]));
  const recording = !!takeCues;

  return (
    <div className="prompter">
      <div className="arr-toolbar">
        <strong className="ellipsis">{item.title}</strong>
        <span className="small muted">
          {slides.length} slide · {data.cues.length} cambi
        </span>
        {!canEdit && <span className="tag">Sola lettura</span>}
        <span className="t-sep" style={{ height: 18 }} />
        {canEdit && lyrics && (
          <>
            <select className="select" value={split} onChange={(e) => setSplit(Number(e.target.value))} title="Righe per slide">
              {SPLITS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <button className="btn btn-sm" onClick={generate} title="Divide il testo del brano in slide; i blocchi ripetuti diventano una slide sola">
              <Icon name="wand" size={14} /> Genera dal testo
            </button>
          </>
        )}
        {canEdit && (
          <button className="btn btn-sm btn-icon" onClick={undo} title="Annulla (Ctrl+Z)">
            <Icon name="undo" size={14} />
          </button>
        )}
        <span className="grow" />
        {!isLoaded && (
          <button className="btn btn-sm btn-primary" onClick={() => player.load(item)}>
            Carica nel player
          </button>
        )}
        {canEdit && (
          <button
            className={`btn btn-sm pr-rec ${armed ? 'is-armed' : ''} ${recording ? 'is-recording' : ''}`}
            disabled={!isLoaded || !slides.length}
            onClick={() => setArmed((a) => !a)}
            title="Registra i cambi di slide durante la riproduzione (R). Sostituisce i cambi nel tratto registrato."
          >
            <Icon name="record" size={12} /> {recording ? 'Registrazione…' : armed ? 'Pronto: premi play' : 'Registra'}
          </button>
        )}
        <select
          className="select"
          value={lead}
          onChange={(e) => update({ prompterLead: Number(e.target.value) })}
          title="Anticipo: le slide compaiono prima del cambio registrato"
        >
          {LEADS.map((v) => (
            <option key={v} value={v}>
              Anticipo {v ? `${v * 1000} ms` : 'nessuno'}
            </option>
          ))}
        </select>
        <button
          className={`btn btn-sm ${settings.prompterNext ? 'is-on' : ''}`}
          onClick={() => update({ prompterNext: !settings.prompterNext })}
          title="Mostra anche la slide successiva sull’uscita"
        >
          Successiva
        </button>
        <button className="btn btn-sm" onClick={onOutput} title="Apri il gobbo su un secondo schermo">
          <Icon name="monitor" size={14} /> Uscita gobbo
        </button>
      </div>

      <div className={`pr-body ${lyrics || canEdit ? '' : 'no-source'}`}>
        {(lyrics || canEdit) && (
          <SourceText key={item.id} text={lyrics} ownLyrics={hasOwnLyrics(item)} canEdit={canEdit} onCreate={addSlide} onSave={saveLyrics} />
        )}

        <div className="pr-col">
          <div className="panel-head">
            Slide
            <span className="grow" />
            {canEdit && (
              <button className="btn btn-ghost btn-sm" onClick={() => addSlide()}>
                <Icon name="plus" size={13} /> Nuova
              </button>
            )}
          </div>
          <div className="pr-slides">
            {!slides.length && (
              <p className="pr-note">
                {lyrics
                  ? 'Scegli quante righe per slide e premi “Genera dal testo”, oppure crea le slide selezionando il testo a sinistra.'
                  : 'Nessuna slide. Scrivi il testo del brano nella pagina Scaletta (scheda “Testo gobbo”) o nell’app web, oppure crea le slide qui.'}
              </p>
            )}
            {slides.map((s, i) => (
              <SlideCard
                key={s.id}
                slide={s}
                index={i}
                count={slides.length}
                uses={uses[s.id]}
                canEdit={canEdit}
                onChange={(patch) => setSlide(s.id, patch)}
                onSplit={(at) => splitSlide(i, at)}
                onMerge={() => mergeSlide(i)}
                onMove={(dir) => moveSlide(i, dir)}
                onDelete={() => deleteSlide(s)}
              />
            ))}
          </div>
        </div>

        <div className="pr-col pr-live">
          <div className="pr-preview">
            <SlideText text={currentSlide?.text} className="pr-current" max={64} />
            {nextSlide && nextSlide !== currentSlide && (
              <div className="pr-next">
                <span>Poi: {slideName(slides, nextSlide.id)}</span>
              </div>
            )}
          </div>

          <div className="panel-head">
            Sequenza
            <span className="grow" />
            {armed && <span className="small muted" style={{ textTransform: 'none', letterSpacing: 0 }}>Invio / ↓ = avanti</span>}
          </div>
          <div className="pr-seq">
            {order.map((id, i) => (
              <button
                key={`${id}-${i}`}
                className={`pr-chip ${recording && i === seqPos ? 'is-next' : ''}`}
                style={{ '--slide-color': slideColor(slides, id) }}
                onClick={() => tap(id, i)}
                disabled={!canEdit || !isLoaded}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (canEdit) change((d) => ({ ...d, order: d.order.filter((_, k) => k !== i) }));
                }}
                title="Clic: cambio a questa slide · clic destro: togli dalla sequenza"
              >
                {slideName(slides, id)}
              </button>
            ))}
            {canEdit && slides.length > 0 && (
              <select
                className="select-xs"
                value=""
                onChange={(e) => e.target.value && change((d) => ({ ...d, order: [...d.order, e.target.value] }))}
                title="Aggiungi una slide alla sequenza"
              >
                <option value="">+ aggiungi</option>
                {slides.map((s) => (
                  <option key={s.id} value={s.id}>
                    {slideName(slides, s.id)}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="panel-head">Slide (tasti 1–9, 0 = vuota)</div>
          <div className="pr-pad">
            <button className="pr-tile is-blank" onClick={() => tap(null)} disabled={!canEdit || !isLoaded}>
              <span className="pr-badge">0</span> Vuota
            </button>
            {slides.map((s, i) => (
              <button
                key={s.id}
                className={`pr-tile ${currentSlide?.id === s.id ? 'is-on' : ''}`}
                style={{ '--slide-color': slideColor(slides, s.id) }}
                onClick={() => tap(s.id)}
                disabled={!canEdit || !isLoaded}
                title={s.text}
              >
                <span className="pr-badge">{i < 9 ? i + 1 : '·'}</span>
                <span className="ellipsis">{slideName(slides, s.id)}</span>
              </button>
            ))}
          </div>

          <div className="panel-head">
            Cambi registrati
            <span className="grow" />
            {canEdit && data.cues.length > 0 && !recording && (
              <button className="btn btn-ghost btn-sm" onClick={clearCues}>
                Svuota
              </button>
            )}
          </div>
          <div className="pr-cues">
            {!cues.length && (
              <p className="pr-note">
                Carica il brano, premi <b>Registra</b> e poi play: durante la riproduzione clicca le slide (o usa i tasti) nel
                momento in cui devono cambiare.
              </p>
            )}
            {cues.map((c, i) => (
              <div key={i} className={`pr-cue ${i === current ? 'is-on' : ''}`} style={{ '--slide-color': slideColor(slides, c.slide) || 'var(--faint)' }}>
                <button className="pr-cue-time mono" onClick={() => player.locate(Math.max(c.t - 2, -10))} title="Vai a 2 s prima del cambio">
                  {fmt(c.t)}
                </button>
                {canEdit && !recording ? (
                  <>
                    <button className="toggle" onClick={() => editCue(i, { t: Math.round((c.t - 0.05) * 1000) / 1000 })} title="−50 ms">
                      −
                    </button>
                    <button className="toggle" onClick={() => editCue(i, { t: Math.round((c.t + 0.05) * 1000) / 1000 })} title="+50 ms">
                      +
                    </button>
                    <select className="select-xs grow" value={c.slide || ''} onChange={(e) => editCue(i, { slide: e.target.value || null })}>
                      <option value="">Vuota</option>
                      {slides.map((s) => (
                        <option key={s.id} value={s.id}>
                          {slideName(slides, s.id)}
                        </option>
                      ))}
                    </select>
                    <button className="toggle" onClick={() => deleteCue(i)} title="Elimina il cambio">
                      <Icon name="x" size={11} />
                    </button>
                  </>
                ) : (
                  <span className="grow ellipsis">{slideName(slides, c.slide)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <CueTimeline
        cues={cues}
        slides={slides}
        tempo={isLoaded ? player.loaded.tempo : null}
        duration={isLoaded ? player.loaded.duration : item.duration}
        editable={canEdit && !recording}
        onLocate={(t) => isLoaded && player.locate(t)}
        onMoveCue={(i, t) => editCue(i, { t: Math.round(t * 1000) / 1000 })}
      />
    </div>
  );
}
