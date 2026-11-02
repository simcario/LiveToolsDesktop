import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatDuration, formatEventDate, isSeparator, PLAYBACK_TYPES } from '../shared/setlists.js';
import { groupLabel, INSTRUMENTS, regionsOf, rehearsalGroup } from '../shared/media.js';
import { groupMixKey } from '../lib/usePlayer';
import { keyLabel } from '../shared/music.js';
import { engine, engineStatus, livePosition, useEngineStatus } from '../lib/engine';
import { laneColor } from '../lib/lanes';
import { itemCacheState, useMediaCache, usePeaks } from '../lib/mediaCache';
import { GRID_RESOLUTIONS, gridLines, jumpTime, jumpToSection, JUMP_QUANTS, nearestBarIndex, nearestLine, SECTION_NAMES, sectionIndexAt } from '../lib/sections';
import { useSections } from '../lib/useSections';
import { getMix, useMix } from '../lib/settings';
import { baseBpm, MAX_TEMPO_DELTA, MAX_TRANSPOSE, PAD_KEYS, playedKey, setItemFields, songChange, TRANSITIONS, transitionLabel, transitionOf } from '../lib/songChange';
import Icon from './Icon';
import Meter from './Meter';
import Toolbar, { ToolGroup } from './Toolbar';

const same = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-3;
const clock = (sec) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const dbText = (db) => (db <= -60 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);
const clampZoom = (z) => Math.round(Math.max(1, Math.min(32, z)) * 100) / 100;
// A manual scroll of the waveform holds back the playhead following for this long (ms).
const FOLLOW_PAUSE = 3000;
const MIN_LINE_GAP = 5; // px between two lines of the grid
const MIN_LABEL_GAP = 34; // px between two bar numbers
const BUBBLE_H = 34; // px of the row of the sections over the waveform

// The jump or loop waiting in the engine, as primitives (stable between two status updates).
function useJump() {
  const at = useEngineStatus((s) => s.jump?.at ?? null);
  const to = useEngineStatus((s) => s.jump?.to ?? null);
  const repeat = useEngineStatus((s) => !!s.jump?.repeat);
  return { at, to, repeat };
}

// Faders: the keyboard stays on the transport after each touch (Space on a focused input would do nothing).
function Fader({ value, onChange, onReset, title }) {
  return (
    <input
      className="fader"
      type="range"
      min={-60}
      max={6}
      step={0.5}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      onDoubleClick={onReset}
      onPointerUp={(e) => e.currentTarget.blur()}
      title={title}
      aria-label={title}
    />
  );
}

function Clock({ duration }) {
  const bar = useEngineStatus((s) => s.bar);
  const beat = useEngineStatus((s) => s.beat);
  const beats = useEngineStatus((s) => s.beats);
  const playing = useEngineStatus((s) => s.playing);
  const total = useEngineStatus((s) => s.duration) || duration || 0;
  const pos = useEngineStatus((s) => Math.floor(Math.max(0, s.position)));
  return (
    <div className="st-lcd st-clock">
      <div className="st-lcd-cell">
        <span className={`st-bars ${bar < 0 ? 'is-count' : ''}`}>
          {bar}.{beat}
        </span>
        <span className="st-leds" aria-hidden="true">
          {Array.from({ length: Math.min(beats, 12) }, (_, i) => (
            <i key={i} className={`${playing && i + 1 === beat ? 'on' : ''} ${i === 0 ? 'first' : ''}`} />
          ))}
        </span>
      </div>
      <div className="st-lcd-cell st-time" title="Tempo trascorso e rimanente">
        <span>{clock(pos)}</span>
        <span className="st-left">-{clock(total - pos)}</span>
      </div>
    </div>
  );
}

// The top bar, as the transport of Playback: tempo, time, back to start, play,
// the song loaded and on the right the commands of the view.
function TopBar({ item, player, editable, editing, setEditing, setlists, setlistId, onSetlist, onVideoOutput }) {
  const fadeTarget = useEngineStatus((s) => s.fadeTarget ?? 1);
  const fade = useEngineStatus((s) => s.fade ?? 1);
  const playing = useEngineStatus((s) => s.playing);
  const waiting = useEngineStatus((s) => s.waiting);
  const loaded = player.loaded;
  const tempo = loaded?.tempo?.segments?.find((s) => !s.countIn);
  const change = songChange(item);
  const bpm = tempo && isLoadedRate(loaded, item) ? Math.round(tempo.bpm * (loaded.rate || 1) * 10) / 10 : change.bpm || item?.bpm;
  const key = playedKey(item);
  const timeSig = tempo?.timeSig || item?.timeSig;
  const isLoaded = !!loaded && loaded.itemId === item?.id;
  return (
    <header className="st-top">
      <div className="st-lcd st-tempo" title="Metro e tempo">
        <span className="st-lcd-big">{timeSig || '–'}</span>
        <span className="st-lcd-small">{bpm ? `${bpm} BPM` : '– BPM'}</span>
      </div>
      <Clock duration={loaded?.duration} />
      <button className="st-round st-back" onClick={() => engine.locate(0)} disabled={!isLoaded || playing} title="Torna all’inizio (a brano fermo)" aria-label="Torna all’inizio">
        <Icon name="skip-back" size={20} />
      </button>
      <button
        className={`st-play ${playing ? (waiting ? 'is-wait' : 'is-on') : ''}`}
        onClick={() => player.toggle(item)}
        disabled={!item}
        title="Play / Stop (Spazio)"
        aria-label={playing ? 'Stop' : 'Play'}
      >
        <Icon name={playing ? 'stop' : 'play'} size={30} />
      </button>
      <button
        className={`st-round st-fade ${fadeTarget < 0.5 ? 'is-on' : ''}`}
        onClick={player.toggleFade}
        disabled={!playing}
        title={fadeTarget < 0.5 ? 'Riporta dentro le tracce (F)' : 'Sfuma le tracce: click e pad restano (F)'}
        aria-label="Fade delle tracce"
        style={{ '--fade': fade }}
      >
        <span>{fadeTarget < 0.5 ? 'IN' : 'FADE'}</span>
      </button>
      <button
        className={`st-round st-pad-btn ${player.padOn ? 'is-on' : ''}`}
        onClick={player.togglePad}
        title={player.padKey == null ? 'Pad: il brano non ha una tonalità (sceglila nel mixer)' : `Pad in ${PAD_KEYS[player.padKey]} (P)`}
        aria-pressed={player.padOn}
        aria-label="Pad"
      >
        <span>PAD</span>
      </button>
      <div className="st-song">
        <h1 className="ellipsis">{item?.title || 'Nessun brano'}</h1>
        <div className="st-facts">
          {key && <b className="st-key">{keyLabel(key)}</b>}
          {change.changed && (
            <span className="tag st-change" title="Tonalità o tempo cambiati per questa scaletta">
              {[change.semitones && `${change.semitones > 0 ? '+' : ''}${change.semitones} st`, change.rate !== 1 && `${change.bpm} BPM`].filter(Boolean).join(' · ')}
            </span>
          )}
          {item?.artist && <span className="ellipsis">{item.artist}</span>}
          {item && !isLoaded && <span className="tag">Da caricare</span>}
        </div>
      </div>
      <div className="st-top-tools">
        {loaded?.video && isLoaded && (
          <button className="st-tool" onClick={onVideoOutput} title="Apri l’uscita video su un secondo schermo">
            <Icon name="monitor" size={18} />
            <span>Video</span>
          </button>
        )}
        {editable && (
          <button className={`st-tool ${editing ? 'is-on' : ''}`} onClick={() => setEditing(!editing)} aria-pressed={editing} title="Crea e sposta le sezioni sulla forma d’onda">
            <Icon name="edit" size={18} />
            <span>{editing ? 'Fine' : 'Modifica'}</span>
          </button>
        )}
        <label className="st-tool st-setlist" title="Scaletta">
          <Icon name="list-music" size={18} />
          <select
            value={setlistId || ''}
            aria-label="Scaletta"
            onChange={(e) => {
              onSetlist(e.target.value);
              e.target.blur();
            }}
          >
            {setlists?.map((s) => (
              <option key={s.id} value={s.id}>
                {[s.title || 'Senza titolo', s.event?.date && formatEventDate(s.event)].filter(Boolean).join(' · ')}
              </option>
            ))}
          </select>
        </label>
      </div>
    </header>
  );
}

// The tempo map of the engine is that of the song loaded: its speed applies only to it.
const isLoadedRate = (loaded, item) => !!loaded && loaded.itemId === item?.id;

const CACHE_DOT = { partial: 'warn', downloading: 'warn', error: 'err' };

const TRANSITION_ICON = { cue: 'skip-forward', stay: 'stop', autolink: 'play', overlap: 'layers', crossfade: 'merge' };

// A small menu under the element that opened it; a touch outside closes it.
function Popover({ anchor, onClose, children }) {
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - 288));
  return (
    <div className="st-pop-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="st-pop" style={{ left, top: r.bottom + 6 }} role="dialog">
        {children}
      </div>
    </div>
  );
}

// Transition from a song to the next, as the circles of Playback.
function TransitionMenu({ item, settings, onPick }) {
  const own = TRANSITIONS.some((t) => t[0] === item.transition);
  return (
    <div className="st-pop-list">
      <strong className="st-pop-title">Dopo “{item.title}”</strong>
      {TRANSITIONS.map(([k, label, hint]) => (
        <button key={k} className={`st-pop-item ${own && item.transition === k ? 'is-on' : ''}`} onClick={() => onPick(k)}>
          <Icon name={TRANSITION_ICON[k]} size={14} />
          <span>
            <b>{label}</b>
            <small>{hint}</small>
          </span>
        </button>
      ))}
      <button className={`st-pop-item ${own ? '' : 'is-on'}`} onClick={() => onPick(null)}>
        <Icon name="settings" size={14} />
        <span>
          <b>Come l’auto-avanzamento</b>
          <small>{settings.autoAdvance ? 'Acceso su questo computer: prepara il prossimo' : 'Spento su questo computer: resta nel brano'}</small>
        </span>
      </button>
    </div>
  );
}

// Key and tempo of a song for this setlist, rendered offline as Playback does.
function ChangeMenu({ item, onChange }) {
  const change = songChange(item);
  const base = baseBpm(item);
  const bpm = Number(item.tempoBpm) > 0 ? Number(item.tempoBpm) : base;
  const key = playedKey(item);
  const setKey = (st) => onChange({ transpose: st ? Math.max(-MAX_TRANSPOSE, Math.min(MAX_TRANSPOSE, st)) : null });
  const setBpm = (v) => {
    const b = Math.round(Math.max(base - MAX_TEMPO_DELTA, Math.min(base + MAX_TEMPO_DELTA, v)) * 10) / 10;
    onChange({ tempoBpm: Math.abs(b - base) < 0.05 ? null : b });
  };
  return (
    <div className="st-pop-list">
      <strong className="st-pop-title">{item.title}</strong>
      <div className="st-pop-row">
        <span>Tonalità</span>
        <button className="btn btn-sm btn-icon" onClick={() => setKey(change.semitones - 1)} disabled={change.semitones <= -MAX_TRANSPOSE} aria-label="Mezzo tono sotto">
          <Icon name="minus" size={14} />
        </button>
        <b className="st-pop-val">
          {key ? keyLabel(key) : `${change.semitones > 0 ? '+' : ''}${change.semitones} st`}
          {key && change.semitones !== 0 && <small> {`${change.semitones > 0 ? '+' : ''}${change.semitones}`}</small>}
        </b>
        <button className="btn btn-sm btn-icon" onClick={() => setKey(change.semitones + 1)} disabled={change.semitones >= MAX_TRANSPOSE} aria-label="Mezzo tono sopra">
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="st-pop-row">
        <span>Tempo</span>
        <button className="btn btn-sm btn-icon" onClick={() => setBpm(bpm - 1)} disabled={!base || bpm <= base - MAX_TEMPO_DELTA} aria-label="1 BPM in meno">
          <Icon name="minus" size={14} />
        </button>
        <b className="st-pop-val">{bpm ? `${bpm} BPM` : '–'}</b>
        <button className="btn btn-sm btn-icon" onClick={() => setBpm(bpm + 1)} disabled={!base || bpm >= base + MAX_TEMPO_DELTA} aria-label="1 BPM in più">
          <Icon name="plus" size={14} />
        </button>
      </div>
      <p className="st-pop-hint">
        Le tracce si rielaborano una volta su ogni computer; click, guide e cue cambiano solo tempo. Vale per tutta la band.
        {!base && ' Per cambiare il tempo il brano deve avere un BPM.'}
      </p>
      <button className="btn btn-sm btn-ghost" onClick={() => onChange({ transpose: null, tempoBpm: null })} disabled={!change.changed}>
        <Icon name="undo" size={13} /> Originale
      </button>
    </div>
  );
}

// The setlist as a row of tiles, with the transition between two songs (Playback):
// a touch on the circle chooses it, the button of a tile its key and tempo.
function SetlistRow({ items, numbers, player, selectedId, liveItemId, onSelect, settings, setlistId, canEdit, notify }) {
  const cache = useMediaCache();
  const playing = useEngineStatus((s) => s.playing);
  const nextId = useEngineStatus((s) => s.next?.songId ?? null);
  const loadedId = player.loaded?.itemId;
  const row = useRef(null);
  const [menu, setMenu] = useState(null); // { kind: 'transition' | 'change', id, anchor }
  useEffect(() => {
    row.current?.querySelector('.is-loaded')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [loadedId]);
  const write = (id, patch) => setItemFields(setlistId, id, patch).catch((e) => notify(`Non salvato: ${e?.message || e}`, true));
  const menuItem = menu && items.find((i) => i.id === menu.id);
  let prev = null;
  return (
    <nav className="st-tiles" ref={row} aria-label="Scaletta">
      {items.map((it) => {
        if (isSeparator(it)) {
          return (
            <div key={it.id} className="st-tile-sep" title={it.title}>
              <span className="ellipsis">{it.title}</span>
              {it.duration > 0 && <span>{formatDuration(it.duration)}</span>}
            </div>
          );
        }
        const before = prev;
        prev = it;
        const st = itemCacheState(it, cache);
        const isLoaded = it.id === loadedId;
        const change = songChange(it);
        const key = playedKey(it);
        const mode = before && transitionOf(before, settings);
        const armed = !!before && nextId === it.id && before.id === loadedId;
        const bpm = change.bpm || it.bpm;
        // While a song plays a touch only selects: it never cuts the music.
        return (
          <div key={it.id} className="st-tile-wrap">
            {before && (
              <button
                className={`st-link st-link-${mode} ${TRANSITIONS.some((t) => t[0] === before.transition) ? 'is-own' : ''} ${armed ? 'is-armed' : ''}`}
                onClick={(e) => setMenu({ kind: 'transition', id: before.id, anchor: e.currentTarget })}
                disabled={!canEdit}
                title={`${transitionLabel(mode)}${armed ? ': pronta' : ''}${canEdit ? ' · tocca per cambiare' : ''}`}
                aria-label={`Transizione: ${transitionLabel(mode)}`}
              >
                <Icon name={TRANSITION_ICON[mode]} size={11} />
              </button>
            )}
            <div className={`st-tile ${isLoaded ? 'is-loaded' : ''} ${it.id === selectedId ? 'is-selected' : ''}`}>
              <button
                className="st-tile-main"
                onClick={() => (playing || isLoaded ? onSelect(it.id) : player.load(it))}
                title={playing ? 'Il brano in corso continua: ferma per caricare questo' : 'Tocca per caricare'}
              >
                <span className="st-tile-top">
                  <span className="st-tile-num">{numbers[it.id]}</span>
                  {key && <b className={`st-tile-key ${change.semitones ? 'is-changed' : ''}`}>{keyLabel(key)}</b>}
                  {it.id === liveItemId && <span className="tag tag-live">LIVE</span>}
                  {CACHE_DOT[st] && <span className={`dot ${CACHE_DOT[st]}`} title="Media da scaricare" />}
                </span>
                <strong className="ellipsis">{it.title}</strong>
                <span className="st-tile-sub ellipsis">
                  {[bpm && `${bpm} BPM${change.rate !== 1 ? ' *' : ''}`, it.duration && formatDuration(it.duration), it.playback && PLAYBACK_TYPES[it.playback]?.label].filter(Boolean).join(' · ')}
                </span>
              </button>
              {canEdit && (
                <button className="st-tile-more" onClick={(e) => setMenu({ kind: 'change', id: it.id, anchor: e.currentTarget })} title="Tonalità e tempo" aria-label="Tonalità e tempo">
                  <Icon name="sliders" size={13} />
                </button>
              )}
            </div>
          </div>
        );
      })}
      {menuItem && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)}>
          {menu.kind === 'transition' ? (
            <TransitionMenu
              item={menuItem}
              settings={settings}
              onPick={(k) => {
                write(menuItem.id, { transition: k });
                setMenu(null);
              }}
            />
          ) : (
            <ChangeMenu item={menuItem} onChange={(patch) => write(menuItem.id, patch)} />
          )}
        </Popover>
      )}
    </nav>
  );
}

// Lines of the grid in the canvas. Zoomed out they thin out instead of filling
// it: the beats leave room to the bars, the bars keep one every 2, 4, 8…
function gridToDraw(lines, secPerPx) {
  const gap = (list) => (list.length > 1 ? (list.at(-1).t - list[0].t) / (list.length - 1) / secPerPx : Infinity);
  const thin = (list, min) => {
    const step = 2 ** Math.max(0, Math.ceil(Math.log2(min / gap(list))));
    return list.filter((_, i) => i % step === 0);
  };
  const list = gap(lines) < MIN_LINE_GAP ? lines.filter((b) => b.inBar === 0) : lines;
  const drawn = thin(list, MIN_LINE_GAP);
  return { drawn, numbered: thin(drawn.filter((b) => b.inBar === 0), MIN_LABEL_GAP) };
}

// Overview of the song: the stems summed in one waveform, under the row of the sections.
// The canvas is as wide as the window on the song, whatever the zoom: it is drawn
// only when it changes or scrolls; the playhead moves through the DOM.
function drawOverview(canvas, { tracks, peaks, regions, duration, width: w, height: h, left, zoom, lines }) {
  if (!w || !h) return;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!(duration > 0)) return;
  const levels = new Float32Array(Math.ceil(w));
  const secPerPx = duration / (w * zoom);
  const t0 = left * secPerPx;
  const grid = lines && gridToDraw(lines, secPerPx);
  const xOf = (t) => Math.round((t - t0) / secPerPx);
  grid?.drawn.forEach((b) => {
    const x = xOf(b.t);
    if (x < 0 || x > w) return;
    ctx.fillStyle = b.inBar === 0 ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(x, BUBBLE_H, 1, h - BUBBLE_H);
  });
  tracks.forEach(({ stem, local }) => {
    const role = stem.role || 'main';
    const p = local && peaks[local];
    if (!p || role === 'click' || role === 'guide' || stem.generated === 'cues') return;
    const pieces = regions[stem.id]?.length ? regions[stem.id] : [{ at: 0, from: 0 }];
    pieces.forEach((r) => {
      if (r.muted) return;
      const from = r.from || 0;
      const len = r.len ?? Math.max(0, p.duration - from);
      const x0 = Math.max(0, Math.floor((r.at - t0) / secPerPx));
      const x1 = Math.min(levels.length, Math.ceil((r.at + len - t0) / secPerPx));
      for (let x = x0; x < x1; x += 1) {
        const a = Math.floor((t0 + x * secPerPx - r.at + from) * p.pps);
        const b = Math.max(a + 1, Math.floor((t0 + (x + 1) * secPerPx - r.at + from) * p.pps));
        for (let k = Math.max(0, a); k < Math.min(p.peaks.length, b); k += 1) if (p.peaks[k] > levels[x]) levels[x] = p.peaks[k];
      }
    });
  });
  ctx.fillStyle = 'rgba(244, 244, 245, 0.7)';
  const top = BUBBLE_H + 4;
  const mid = top + (h - top) / 2;
  levels.forEach((v, x) => {
    const a = (v / 255) * ((h - top) / 2 - 3);
    if (a > 0.3) ctx.fillRect(x, mid - a, 1, a * 2);
  });
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.font = '600 10px system-ui, sans-serif';
  grid?.numbered.forEach((b) => {
    const x = xOf(b.t);
    if (x >= -MIN_LABEL_GAP && x <= w) ctx.fillText(String(b.bar), x + 3, h - 4);
  });
}

// The waveform with the sections on it, as in Playback: a touch on a section
// queues the jump there, the loop icon of the section in progress repeats it.
function Overview({ loaded, item, sections, index, beats, jump, onSeek, onSection, onLoop, edit, canEdit, settings, update }) {
  const peaks = usePeaks();
  const [drag, setDrag] = useState(null); // { index, bar } of the marker being dragged
  const canvas = useRef(null);
  const scroller = useRef(null);
  const head = useRef(null);
  const played = useRef(null);
  const paint = useRef(() => {});
  const left = useRef(0); // scroll of the waveform, known even when the browser is clamping it
  const userAt = useRef(0); // when the user last scrolled by hand
  const lastPos = useRef(null);
  const anchorX = useRef(null); // Ctrl+wheel: the point of the window that stays put on the next zoom
  const duration = loaded?.duration || 0;
  const regions = useMemo(() => regionsOf(item), [item]);
  const tracks = loaded?.tracks;
  const zoom = clampZoom(settings.stageZoom);
  const zoomNow = useRef(zoom);
  zoomNow.current = zoom;
  const lines = useMemo(() => (settings.stageGrid ? gridLines(beats, settings.stageGridRes) : null), [beats, settings.stageGrid, settings.stageGridRes]);

  const scrollTo = (x) => {
    const el = scroller.current;
    el.scrollLeft = x;
    left.current = el.scrollLeft;
  };

  useEffect(() => {
    const c = canvas.current;
    const el = scroller.current;
    paint.current = () => drawOverview(c, { tracks: tracks || [], peaks, regions, duration, width: el.clientWidth, height: el.clientHeight, left: el.scrollLeft, zoom, lines });
    paint.current();
    const ro = new ResizeObserver(() => paint.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, [tracks, peaks, regions, duration, zoom, lines]);

  // Zooming keeps in place the pointer, or else the playhead, or else the middle of the window.
  const prevZoom = useRef(zoom);
  useLayoutEffect(() => {
    const prev = prevZoom.current;
    prevZoom.current = zoom;
    const w = scroller.current.clientWidth;
    if (prev === zoom || !w) return;
    const d = engineStatus().duration || duration;
    const headX = d ? (livePosition() / d) * w * prev - left.current : -1;
    const x = anchorX.current ?? (headX >= 0 && headX <= w ? headX : w / 2);
    anchorX.current = null;
    scrollTo(((left.current + x) / (w * prev)) * w * zoom - x);
  }, [zoom, duration]);

  useEffect(() => {
    scrollTo(0);
    userAt.current = 0;
  }, [loaded?.itemId]);

  // Not a React handler: those are passive, and Ctrl+wheel must not reach the page.
  useEffect(() => {
    const el = scroller.current;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const next = clampZoom(zoomNow.current * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
        if (next === zoomNow.current) return;
        anchorX.current = e.clientX - el.getBoundingClientRect().left;
        userAt.current = performance.now();
        update({ stageZoom: next });
      } else if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [update]);

  const scrollRaf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(scrollRaf.current), []);
  const onScroll = () => {
    const x = scroller.current.scrollLeft;
    if (Math.abs(x - left.current) > 1) userAt.current = performance.now();
    left.current = x;
    cancelAnimationFrame(scrollRaf.current);
    scrollRaf.current = requestAnimationFrame(() => paint.current());
  };

  useEffect(() => {
    let raf;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const st = engineStatus();
      const d = st.duration || duration;
      const pos = livePosition();
      const pct = d ? Math.max(0, Math.min(100, (pos / d) * 100)) : 0;
      // Zoomed in, the playhead stays in the window; at rest it moves it only if it goes out.
      const el = scroller.current;
      if (el && el.scrollWidth > el.clientWidth && pos !== lastPos.current && performance.now() - userAt.current > FOLLOW_PAUSE) {
        const px = (pct / 100) * el.scrollWidth;
        const rel = px - el.scrollLeft;
        if (rel < 0 || rel > el.clientWidth * (st.playing ? 0.85 : 1)) scrollTo(px - el.clientWidth * 0.15);
      }
      lastPos.current = pos;
      if (head.current) head.current.style.left = `${pct}%`;
      if (played.current) played.current.style.width = `${pct}%`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [duration]);

  const pct = (t) => `${duration ? (t / duration) * 100 : 0}%`;
  const timeAt = (e, box) => {
    const r = box.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * duration;
  };
  const tap = (e) => {
    if (duration) onSeek(timeAt(e, e.currentTarget));
  };
  // A marker: a touch selects it, a drag moves it from bar to bar.
  const grab = (e, s) => {
    e.stopPropagation();
    const el = e.currentTarget;
    const box = el.closest('.st-ov-track');
    el.setPointerCapture(e.pointerId);
    const from = e.clientX;
    let bar = null;
    const move = (ev) => {
      if (bar == null && Math.abs(ev.clientX - from) < 4) return;
      userAt.current = performance.now();
      bar = nearestBarIndex(edit.bars, timeAt(ev, box));
      setDrag({ index: s.index, bar });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDrag(null);
      if (bar == null) edit.onSelect(s.index);
      else edit.onMove(s.index, bar);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return (
    <div className={`st-overview ${edit ? 'is-edit' : ''}`}>
      <canvas ref={canvas} />
      <div className="st-ov-scroll" ref={scroller} onScroll={onScroll}>
        <div
          className="st-ov-track"
          style={{ width: `${zoom * 100}%` }}
          onClick={tap}
          title={settings.stageGrid ? 'Tocca per spostarti: la testina arriva alla linea della griglia più vicina (Ctrl+rotella: zoom)' : 'Tocca per spostarti: la testina arriva alla battuta più vicina (Ctrl+rotella: zoom)'}
        >
          {sections.map((s) => (
            <span key={s.start} className="st-band" style={{ left: pct(s.start), width: pct(s.end - s.start), '--sec': s.color }} />
          ))}
          <span className="st-played" ref={played} />
          {jump.repeat && <span className="st-loop-range" style={{ left: pct(jump.to), width: pct(jump.at - jump.to) }} />}
          {jump.at != null && !jump.repeat && <span className="st-jump-at" style={{ left: pct(jump.at) }} />}
          {sections.map((s, i) => {
            const isCurrent = i === index;
            const isLoop = jump.repeat && same(jump.to, s.start);
            const isQueued = !jump.repeat && same(jump.to, s.start);
            const n = i + 1;
            return (
              <span
                key={s.start}
                className={`st-sec ${isCurrent ? 'is-current' : ''} ${isQueued ? 'is-queued' : ''} ${isLoop ? 'is-loop' : ''} ${edit?.selected === s.index ? 'is-selected' : ''}`}
                style={{ left: pct(s.start), width: pct(s.end - s.start), '--sec': s.color }}
              >
                <button
                  className="st-bubble"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSection(s);
                  }}
                  title={edit ? `Scegli ${s.label}` : isQueued ? 'In coda: tocca di nuovo per annullare' : `Salta a ${s.label}${n <= 9 ? ` (${n})` : ''}`}
                >
                  <i className="st-bubble-num">{n}</i>
                  <span className="ellipsis">{s.label}</span>
                  {s.bars > 0 && <span className="st-bubble-bars">{s.bars}</span>}
                </button>
                {!edit && isCurrent && (
                  <button
                    className={`st-bubble-loop ${isLoop ? 'is-on' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onLoop(true);
                    }}
                    aria-pressed={isLoop}
                    title={isLoop ? 'Esci dal loop (L)' : 'Loop infinito della sezione (L)'}
                    aria-label="Loop della sezione"
                  >
                    <Icon name="repeat" size={13} />
                  </button>
                )}
              </span>
            );
          })}
          {edit &&
            sections.map((s) => {
              const dragged = drag?.index === s.index ? edit.bars[drag.bar] : null;
              return (
                <span
                  key={s.index}
                  className={`st-marker ${edit.selected === s.index ? 'is-on' : ''}`}
                  style={{ left: pct(dragged ? dragged.t : s.start), '--sec': s.color }}
                  onPointerDown={(e) => grab(e, s)}
                  onClick={(e) => e.stopPropagation()}
                  title={`${s.label}: trascina per spostarla, tocca per rinominarla`}
                >
                  <i />
                  {dragged && <b>Batt. {dragged.bar}</b>}
                </span>
              );
            })}
          <span className="st-head" ref={head} />
        </div>
      </div>
      {!loaded && <div className="st-ov-empty muted">Carica un brano dalla scaletta: qui compaiono la forma d’onda e le sue sezioni.</div>}
      {loaded && !sections.length && !edit && (
        <div className="st-ov-empty muted">
          “{item?.title}” non ha sezioni: {canEdit ? <>creale con <b>Modifica</b></> : 'chi può modificare la scaletta può crearle'}, serviranno per saltare e mettere in loop.
        </div>
      )}
    </div>
  );
}

// Zoom of the waveform: the steps of the Arrangement, down to the whole song.
function ZoomControls({ settings, update }) {
  const zoom = clampZoom(settings.stageZoom);
  return (
    <span className="st-view">
      <button className="btn btn-sm btn-icon" onClick={() => update({ stageZoom: clampZoom(zoom / 1.5) })} disabled={zoom <= 1} title="Riduci lo zoom (Ctrl + rotella)" aria-label="Riduci lo zoom">
        <Icon name="zoom-out" size={15} />
      </button>
      <span className="st-zoom mono" title="Zoom della forma d’onda">
        ×{Math.round(zoom * 10) / 10}
      </span>
      <button className="btn btn-sm btn-icon" onClick={() => update({ stageZoom: clampZoom(zoom * 1.5) })} disabled={zoom >= 32} title="Aumenta lo zoom (Ctrl + rotella)" aria-label="Aumenta lo zoom">
        <Icon name="zoom-in" size={15} />
      </button>
      <button className="btn btn-sm btn-icon" onClick={() => update({ stageZoom: 1 })} disabled={zoom <= 1} title="Adatta il brano alla finestra" aria-label="Adatta il brano alla finestra">
        <Icon name="maximize" size={14} />
      </button>
    </span>
  );
}

function GridControls({ settings, update }) {
  const on = settings.stageGrid;
  return (
    <span className="st-view">
      <button className={`btn btn-sm btn-icon ${on ? 'is-on' : ''}`} onClick={() => update({ stageGrid: !on })} aria-pressed={on} title={on ? 'Nascondi la griglia' : 'Mostra la griglia'} aria-label="Griglia">
        <Icon name="grid" size={14} />
      </button>
      <select
        className="st-grid-res"
        value={settings.stageGridRes}
        disabled={!on}
        aria-label="Risoluzione della griglia"
        title="Risoluzione della griglia: un tocco sulla forma d’onda arriva alla linea più vicina"
        onChange={(e) => {
          update({ stageGridRes: e.target.value });
          e.target.blur();
        }}
      >
        {GRID_RESOLUTIONS.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
    </span>
  );
}

// The section in progress and how many bars it still has.
function NowLine({ sections, index }) {
  const bar = useEngineStatus((s) => s.bar);
  const cur = sections[index];
  if (!cur) {
    const left = Math.max(0, sections[0].bar - bar);
    return (
      <span className="st-now muted">
        → {sections[0].label} tra {left} {left === 1 ? 'battuta' : 'battute'}
      </span>
    );
  }
  const nextSec = sections[index + 1];
  const left = cur.endBar != null ? Math.max(0, cur.endBar - bar) : null;
  return (
    <span className="st-now">
      <b style={{ color: cur.color }}>{cur.label}</b>
      {nextSec ? (
        <span className="muted">
          {' '}
          → {nextSec.label}
          {left != null && ` tra ${left} ${left === 1 ? 'battuta' : 'battute'}`}
        </span>
      ) : (
        <span className="muted"> · ultima sezione</span>
      )}
    </span>
  );
}

// The section selected on the waveform: its name, or the marker removed.
function MarkerEditor({ s, onRename, onRemove }) {
  if (!s) return <p className="st-marker-edit muted">Tocca la forma d’onda per spostare la testina, premi l’icona del marker per aggiungere lì una sezione, trascina un marker per spostarlo.</p>;
  const commit = (e) => {
    const label = e.target.value.trim();
    if (label !== s.name) onRename(s.index, label);
  };
  return (
    <div className="st-marker-edit" style={{ '--sec': s.color }}>
      <i className="st-swatch" />
      <input
        key={`${s.index}-${s.name}`}
        className="input"
        defaultValue={s.name}
        placeholder={s.label}
        aria-label="Nome della sezione"
        autoFocus
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.target.blur();
          if (e.key === 'Escape') {
            e.target.value = s.name;
            e.target.blur();
          }
        }}
      />
      <span className="st-names">
        {SECTION_NAMES.map((n) => (
          <button key={n} className="toggle" onClick={() => onRename(s.index, n)}>
            {n}
          </button>
        ))}
      </span>
      <span className="grow" />
      <span className="small muted">Batt. {s.bar}</span>
      <button className="btn btn-sm btn-ghost" onClick={() => onRemove(s.index)} title="La sezione prima prende le sue battute">
        <Icon name="trash" size={13} /> Elimina
      </button>
    </div>
  );
}

// The bar over the waveform: what is playing, when the jumps happen, zoom and grid;
// in the edit mode the tools of the markers.
function WaveBar({ sections, index, settings, update, tools }) {
  if (tools?.editing) {
    return (
      <div className="st-wavebar">
        <strong className="st-now">Modifica sezioni</strong>
        <span className="grow" />
        <ZoomControls settings={settings} update={update} />
        <GridControls settings={settings} update={update} />
        <button className="btn btn-sm btn-icon" onClick={tools.addAtPlayhead} title="Aggiungi un marker alla battuta della testina" aria-label="Aggiungi un marker">
          <Icon name="marker-add" size={16} />
        </button>
        <button className="btn btn-sm btn-icon" onClick={() => tools.travel(-1)} disabled={!tools.canUndo} title={tools.undoLabel ? `Annulla: ${tools.undoLabel} (Ctrl+Z)` : 'Niente da annullare'} aria-label="Annulla">
          <Icon name="undo" size={14} />
        </button>
        <button className="btn btn-sm btn-icon" onClick={() => tools.travel(1)} disabled={!tools.canRedo} title={tools.redoLabel ? `Ripeti: ${tools.redoLabel} (Ctrl+Shift+Z)` : 'Niente da ripetere'} aria-label="Ripeti">
          <Icon name="undo" size={14} className="icon-flip" />
        </button>
        {tools.dirty && (
          <span className="arr-save">
            <span className="small arr-unsaved">Non salvato</span>
            <button className="btn btn-sm btn-ghost" onClick={tools.discard} disabled={tools.saving} title="Torna all’ultimo salvataggio">
              Scarta
            </button>
            <button className="btn btn-sm btn-primary" onClick={tools.save} disabled={tools.saving} title="Salva il brano per tutta la band">
              <Icon name="check" size={13} /> {tools.saving ? 'Salvataggio…' : 'Salva'}
            </button>
          </span>
        )}
      </div>
    );
  }
  return (
    <Toolbar id="stage" title="Palco" className="st-wavebar">
      <ToolGroup id="now" label="Sezione in corso" locked grow>
        {sections.length ? <NowLine sections={sections} index={index} /> : <span className="st-now muted">Sezioni</span>}
      </ToolGroup>
      <ToolGroup id="quant" label="Quando saltare">
        <div className="st-quant" role="group" aria-label="Quando avviene il salto">
          {JUMP_QUANTS.map(([k, label, hint]) => (
            <button key={k} className={settings.jumpQuant === k ? 'is-on' : ''} onClick={() => update({ jumpQuant: k })} title={hint}>
              {label}
            </button>
          ))}
        </div>
      </ToolGroup>
      <ToolGroup id="zoom" label="Zoom">
        <ZoomControls settings={settings} update={update} />
      </ToolGroup>
      <ToolGroup id="grid" label="Griglia">
        <GridControls settings={settings} update={update} />
      </ToolGroup>
    </Toolbar>
  );
}

// A rehearsal group (instrument, click, guides): its volume on top of that of its
// tracks. As in Playback a touch on the name takes it out of the mix, S solos all its tracks.
function GroupStrip({ group, color, indexes, names, solo, out, player }) {
  const label = groupLabel(group);
  const gain = getMix(groupMixKey(group)).gainDb || 0;
  return (
    <div className={`st-strip ${out ? 'is-muted' : ''}`} style={{ '--sec': color }}>
      <span className="m-db">{dbText(gain)}</span>
      <div className="st-fader-row">
        <Fader value={gain} onChange={(gainDb) => player.setGroup(group, { gainDb })} onReset={() => player.setGroup(group, { gainDb: 0 })} title={`Volume ${label} (doppio clic: 0 dB)`} />
        <Meter track={indexes} />
      </div>
      <button className={`st-solo ${solo ? 'is-on' : ''}`} onClick={() => player.setGroup(group, { solo: !solo })} aria-pressed={solo} title="Solo">
        S
      </button>
      <button className="st-name" onClick={() => player.toggleGroup(group)} aria-pressed={out} title={`${out ? 'Rimetti nel mix' : 'Togli dal mix'} · ${names.join(', ')}`}>
        <span className="ellipsis">{label}</span>
        {indexes.length > 1 && <span className="st-strip-count">{indexes.length}</span>}
      </button>
    </div>
  );
}

const GROUP_ORDER = [...Object.keys(INSTRUMENTS), 'click', 'guide'];

// The tracks of the song by rehearsal group, in the order of the Rehearsal buttons.
function trackGroups(tracks) {
  const by = new Map();
  tracks.forEach(({ stem }, index) => {
    const g = rehearsalGroup(stem);
    if (!by.has(g)) by.set(g, []);
    by.get(g).push({ stem, index });
  });
  const rank = (g) => (GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : GROUP_ORDER.length);
  return [...by].sort((a, b) => rank(a[0]) - rank(b[0]));
}

// The console on the left of the mixer: Loop plays the section in progress once
// more, Loop ∞ repeats it until pressed again.
function Console({ sections, index, jump, onLoop }) {
  const cur = sections[index];
  const infinite = jump.repeat;
  const once = !jump.repeat && cur && same(jump.to, cur.start) && same(jump.at, cur.end);
  return (
    <div className="st-console">
      <button className={`st-cbtn ${once ? 'is-on' : ''}`} onClick={() => onLoop(false)} disabled={!cur && !once} aria-pressed={!!once} title="Ripete una volta la sezione in corso">
        <Icon name="repeat" size={18} />
        <span>Loop</span>
      </button>
      <button className={`st-cbtn ${infinite ? 'is-on' : ''}`} onClick={() => onLoop(true)} disabled={!cur && !infinite} aria-pressed={infinite} title="Ripete la sezione in corso finché non lo premi di nuovo (L)">
        <Icon name="repeat" size={18} />
        <span>Loop ∞</span>
      </button>
      <button className="st-cbtn" onClick={() => engine.cancelJump()} disabled={jump.at == null} title="Annulla il salto in coda o esce dal loop (Esc)">
        <Icon name="x" size={18} />
        <span>Annulla</span>
      </button>
    </div>
  );
}

// Pad Player: volume, key (of the song, as Playback's LINK, or chosen here, LIVE), on/off on the name.
function PadStrip({ player, settings, update }) {
  const pad = settings.pad;
  const set = (patch) => update({ pad: { ...pad, ...patch } });
  const value = pad.mode === 'live' ? pad.key : 'link';
  return (
    <div className={`st-strip st-strip-fixed st-padstrip ${player.padOn ? '' : 'is-muted'}`} style={{ '--sec': '#a78bfa' }}>
      <span className="m-db">{dbText(pad.gainDb)}</span>
      <div className="st-fader-row">
        <Fader value={pad.gainDb} onChange={(gainDb) => set({ gainDb })} onReset={() => set({ gainDb: -10 })} title="Volume pad (doppio clic: -10 dB)" />
      </div>
      <select
        className="st-pad-key"
        value={value}
        aria-label="Tonalità del pad"
        title="Tonalità del pad: quella del brano caricato o una scelta qui"
        onChange={(e) => {
          const v = e.target.value;
          set(v === 'link' ? { mode: 'link' } : { mode: 'live', key: v });
          e.target.blur();
        }}
      >
        <option value="link">Brano{pad.mode !== 'live' && player.padKey != null ? ` · ${PAD_KEYS[player.padKey]}` : ''}</option>
        {PAD_KEYS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <button className="st-name" onClick={player.togglePad} aria-pressed={player.padOn} title={player.padOn ? 'Spegni il pad (P)' : 'Accendi il pad (P)'}>
        <span className="ellipsis">Pad</span>
      </button>
    </div>
  );
}

function Mixer({ loaded, lanes, player, settings, update, children }) {
  useMix(); // re-render on local mix changes
  const channels = useEngineStatus((s) => s.device?.channels ?? 2);
  const click = settings.click;
  const groups = useMemo(() => trackGroups(loaded?.tracks || []), [loaded?.tracks]);
  return (
    <section className="st-mixer">
      {children}
      <div className="st-strip st-strip-fixed st-master" style={{ '--sec': '#f4f4f5' }}>
        <span className="m-db">{dbText(settings.masterDb)}</span>
        <div className="st-fader-row">
          <Fader value={settings.masterDb} onChange={(masterDb) => update({ masterDb })} onReset={() => update({ masterDb: 0 })} title="Master tracce (doppio clic: 0 dB)" />
          <span className="meter" style={{ gap: 3 }}>
            {Array.from({ length: Math.min(8, channels) }, (_, i) => (
              <Meter key={i} output={i} />
            ))}
          </span>
        </div>
        <span className="st-solo is-blank" />
        <span className="st-name is-static">Master</span>
      </div>
      <div className={`st-strip st-strip-fixed ${click.enabled ? '' : 'is-muted'}`} style={{ '--sec': '#06b6d4' }}>
        <span className="m-db">{dbText(click.gainDb)}</span>
        <div className="st-fader-row">
          <Fader value={click.gainDb} onChange={(gainDb) => update({ click: { ...click, gainDb } })} onReset={() => update({ click: { ...click, gainDb: -6 } })} title="Volume click" />
        </div>
        <span className="st-solo is-blank" />
        <button className="st-name" onClick={() => update({ click: { ...click, enabled: !click.enabled } })} aria-pressed={!click.enabled} title="Click acceso / spento (C)">
          <span className="ellipsis">Metronomo</span>
        </button>
      </div>
      <PadStrip player={player} settings={settings} update={update} />
      <div className="st-tracks">
        {groups.length ? (
          groups.map(([group, list]) => (
            <GroupStrip
              key={group}
              group={group}
              color={laneColor(lanes, list[0].stem)}
              indexes={list.map((t) => t.index)}
              names={list.map((t) => t.stem.name)}
              solo={list.every((t) => player.solos[t.stem.id])}
              out={!!player.leftOut[group]}
              player={player}
            />
          ))
        ) : (
          <p className="st-map-empty muted">I gruppi di strumenti del brano caricato compaiono qui.</p>
        )}
      </div>
    </section>
  );
}

// The Palco view, laid out as Playback: transport on top, the setlist as tiles,
// the waveform with the sections and the mixer with its console. The engine
// does the jumps, on the grid and without gaps.
export default function StageView({ items, numbers, lanes, player, selected, liveItemId, onSelect, setlists, setlistId, onSetlist, settings, update, active, onVideoOutput, canEdit, notify }) {
  const loaded = player.loaded;
  const item = player.loadedItem || selected;
  const jump = useJump();
  const sec = useSections({ player, setlistId, canEdit, notify, quant: settings.jumpQuant });
  const { beats, bars, sections } = sec;
  const index = useEngineStatus((s) => sectionIndexAt(sections, Math.max(0, s.position)));

  // Markers on the waveform, only in the edit mode.
  const editable = sec.editable && !!loaded;
  const [wantEdit, setEditing] = useState(false);
  const editing = wantEdit && editable;
  const [marker, setMarker] = useState(null); // index of the selected section
  useEffect(() => {
    setEditing(false);
    setMarker(null);
  }, [loaded?.itemId]);
  const goHistory = async (dir) => {
    await sec.travel(dir);
    setMarker(null);
  };

  const tapSection = (s) => {
    if (same(jump.to, s.start)) engine.cancelJump();
    else jumpToSection(s, settings.jumpQuant, beats, sections);
  };
  // infinite: until pressed again; otherwise the section in progress plays once more.
  const loop = (infinite) => {
    const st = engineStatus();
    const s = sections[sectionIndexAt(sections, Math.max(0, st.position))];
    const on = infinite ? !!st.jump?.repeat : !!s && !st.jump?.repeat && same(st.jump?.to, s.start) && same(st.jump?.at, s.end);
    if (on) engine.cancelJump();
    else if (s) engine.scheduleJump({ at: s.end, to: s.start, repeat: infinite });
  };

  // Keys of the view (pedalboards can send them too): 1-9 section, L loop, Esc cancel,
  // and in the edit mode Ctrl+Z / Ctrl+Shift+Z.
  const keys = useRef(null);
  keys.current = { tapSection, loop, sections, editing, goHistory, player };
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.altKey || e.target.closest?.('input, select, textarea')) return;
      const k = keys.current;
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        const dir = key === 'z' ? (e.shiftKey ? 1 : -1) : key === 'y' ? 1 : 0;
        if (dir && k.editing) {
          e.preventDefault();
          k.goHistory(dir);
        }
        return;
      }
      if (e.repeat || k.editing) return;
      if (/^[1-9]$/.test(e.key)) {
        const s = k.sections[Number(e.key) - 1];
        if (s) k.tapSection(s);
      } else if (e.key === 'l' || e.key === 'L') {
        k.loop(true);
      } else if (e.key === 'p' || e.key === 'P') {
        k.player.togglePad();
      } else if (e.key === 'f' || e.key === 'F') {
        k.player.toggleFade();
      } else if (e.key === 'Escape') {
        engine.cancelJump();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const tools = !editable
    ? null
    : {
        editing,
        selected: marker,
        dirty: sec.dirty,
        saving: sec.saving,
        canUndo: sec.canUndo,
        undoLabel: sec.undoLabel,
        canRedo: sec.canRedo,
        redoLabel: sec.redoLabel,
        travel: goHistory,
        addAtPlayhead: () => {
          const i = sec.addAtPlayhead();
          if (i != null) setMarker(i);
        },
        save: sec.save,
        discard: () => {
          if (sec.discard()) setMarker(null);
        },
      };
  const edit = editing
    ? {
        bars,
        selected: marker,
        onSelect: setMarker,
        // Moving the first marker can shift all the indexes by one.
        onMove: (i, bar) => {
          const at = sec.move(i, bar);
          if (at != null && marker != null) setMarker(marker + at - i);
        },
      }
    : null;

  const onSeek = (t) => {
    const st = engineStatus();
    const res = settings.stageGrid ? settings.stageGridRes : '1';
    // In the music a jump lands on a bar at most: on any beat it would turn the bars around.
    if (st.playing && st.position >= 0) {
      const to = nearestLine(gridLines(beats, res === 'beat' ? '1' : res), t);
      engine.scheduleJump({ at: jumpTime(settings.jumpQuant === 'beat' ? 'beat' : 'bar', st.position, beats, sections), to, repeat: false });
    } else engine.locate(nearestLine(gridLines(beats, res), t));
  };

  return (
    <div
      className={`stage ${editing ? 'is-editing' : ''}`}
      // A touch must not leave the focus on a button: Space and Enter belong to the transport.
      onMouseDown={(e) => {
        if (e.target.closest('button')) e.preventDefault();
      }}
    >
      <TopBar
        item={item}
        player={player}
        editable={editable}
        editing={editing}
        setEditing={setEditing}
        setlists={setlists}
        setlistId={setlistId}
        onSetlist={onSetlist}
        onVideoOutput={onVideoOutput}
      />
      <SetlistRow items={items} numbers={numbers} player={player} selectedId={selected?.id} liveItemId={liveItemId} onSelect={onSelect} settings={settings} setlistId={setlistId} canEdit={canEdit} notify={notify} />
      <section className="st-wave">
        <WaveBar sections={sections} index={index} settings={settings} update={update} tools={tools} />
        {editing && <MarkerEditor s={sections.find((s) => s.index === marker)} onRename={sec.rename} onRemove={(i) => sec.remove(i) && setMarker(null)} />}
        <Overview
          loaded={loaded}
          item={player.loadedItem}
          sections={sections}
          index={index}
          beats={beats}
          jump={jump}
          onSeek={onSeek}
          onSection={editing ? (s) => setMarker(s.index) : tapSection}
          onLoop={loop}
          edit={edit}
          canEdit={sec.editable}
          settings={settings}
          update={update}
        />
      </section>
      <Mixer loaded={loaded} lanes={lanes} player={player} settings={settings} update={update}>
        <Console sections={sections} index={index} jump={jump} onLoop={loop} />
      </Mixer>
    </div>
  );
}
