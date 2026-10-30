import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { engineStatus, livePosition, useEngineStatus } from '../lib/engine';
import { gridBeats, moveAnchor, nearestOnset, removeAnchor, shiftAnchors, tapBpm } from '../lib/grid';
import { laneColor, ROLE_COLORS } from '../lib/lanes';
import { usePeaks } from '../lib/mediaCache';
import { useOnsets } from '../lib/onsets';
import { gridOf } from '../lib/sync';
import { getMix, outputOptions, parseRoute, routeValue, useMix } from '../lib/settings';
import Icon from './Icon';
import Meter from './Meter';
import SyncControl from './SyncControl';
import { CueHeader, cueCellAt, drawCueLane, useCueTrack, useNowCue } from './CueLane';
import { CuePicker } from './CuePicker';
import InsertBarsModal from './InsertBarsModal';
import { cutAt, keepGrid, moveSegment, removeSegment, segmentEnd, segmentIndexAt, snapToBeat, stemRegions, toggleSegmentMute, trimSegment } from '../lib/arrange';
import { clearHistory, recordStep, travel, useHistory } from '../lib/arrangeHistory';
import { discardDraft, editDraft, saveDraft, useDrafts } from '../lib/drafts';
import { regionsOf, stemsOf } from '../shared/media.js';

const RULER_H = 30;
const LANE_H = 64;
const MIN_PPS = 4;
const MAX_PPS = 400;

// Tools for the segments of the tracks (Cubase style), with their keys and cursors.
const TOOLS = [
  ['select', 'pointer', 'Selezione · trascina un bordo per accorciare il segmento', '1', 'default'],
  ['move', 'hand', 'Sposta: trascina i segmenti (i bordi li accorciano)', '2', 'grab'],
  ['cut', 'scissors', 'Taglia dove clicchi', '3', 'crosshair'],
  ['mute', 'x', 'Muta / riattiva un segmento', '4', 'pointer'],
  ['erase', 'eraser', 'Elimina un segmento', '5', 'not-allowed'],
];

const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

function draw(canvas, { width, height, scroll, pps, t0, tempo, rows, peaks, duration, warp, cue }) {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const x = (t) => (t - t0) * pps - scroll;
  const tStart = t0 + scroll / pps;
  const tEnd = tStart + width / pps;

  // Lanes background
  rows.forEach((r, i) => {
    ctx.fillStyle = i % 2 ? '#121a28' : '#141c2b';
    ctx.fillRect(0, RULER_H + i * LANE_H, width, LANE_H);
  });

  // Grid: the beats (quarters) whenever they fit, and the bars; zoomed out,
  // bars are numbered every 1, 2, 4, 8… so the grid keeps its proportions.
  const beats = gridBeats(tempo, tStart - 1, tEnd + 1);
  const barList = beats.filter((b) => b.inBar === 0);
  const minGap = 46;
  const barGap = barList.length > 1 ? barList[1].t - barList[0].t : 1;
  const step = 2 ** Math.max(0, Math.ceil(Math.log2(minGap / Math.max(1e-3, barGap * pps))));
  ctx.font = '600 10px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#0d131e';
  ctx.fillRect(0, 0, width, RULER_H);
  beats.forEach((b) => {
    const bx = Math.round(x(b.t)) + 0.5;
    if (b.inBar !== 0) {
      if (pps * b.seg.beat < 6) return;
      ctx.strokeStyle = warp ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.045)';
      ctx.beginPath();
      ctx.moveTo(bx, warp ? 24 : RULER_H);
      ctx.lineTo(bx, height);
      ctx.stroke();
      return;
    }
    // Numbered by bar, whatever the segments (one per bar with a click track).
    const showNum = (b.bar - 1) % step === 0 || (b.seg.countIn && b.bar === b.seg.firstBar);
    if (!showNum && (b.bar - 1) % Math.max(1, step / 4) !== 0) return;
    ctx.strokeStyle = b.seg.countIn ? 'rgba(34,211,238,0.25)' : showNum ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)';
    ctx.beginPath();
    ctx.moveTo(bx, showNum ? 14 : 22);
    ctx.lineTo(bx, height);
    ctx.stroke();
    if (showNum) {
      ctx.fillStyle = b.seg.countIn ? '#22d3ee' : '#94a3b8';
      ctx.fillText(String(b.bar), bx + 4, 9);
    }
  });

  // Section locators (from the song's sections in the web app)
  (tempo?.segments || []).forEach((s) => {
    if (!s.label || s.countIn) return;
    const sx = x(s.start);
    if (sx < -200 || sx > width) return;
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(sx, 16);
    ctx.lineTo(sx + 8, 22);
    ctx.lineTo(sx, 28);
    ctx.fill();
    ctx.font = '700 10px Inter, sans-serif';
    ctx.fillStyle = '#fbbf24';
    ctx.fillText(s.label, sx + 11, 22);
    ctx.strokeStyle = 'rgba(245,158,11,0.35)';
    ctx.beginPath();
    ctx.moveTo(Math.round(sx) + 0.5, RULER_H);
    ctx.lineTo(Math.round(sx) + 0.5, height);
    ctx.stroke();
  });
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath();
  ctx.moveTo(0, RULER_H - 0.5);
  ctx.lineTo(width, RULER_H - 0.5);
  ctx.stroke();

  // Clips
  rows.forEach((r, i) => {
    const y = RULER_H + i * LANE_H;
    if (r.kind === 'cue') {
      drawCueLane(ctx, { y, h: LANE_H, width, x, ...cue });
      return;
    }
    if (r.kind === 'click') {
      ctx.fillStyle = 'rgba(6,182,212,0.6)';
      beats.forEach((b) => {
        const h = b.inBar === 0 ? LANE_H - 18 : (LANE_H - 18) * 0.45;
        ctx.fillRect(Math.round(x(b.t)), y + LANE_H - 9 - h, 2, h);
      });
      return;
    }
    // Audio: one clip per region (moved, or cut by inserted bars); video: one clip at its offset.
    const pieces =
      r.kind === 'video'
        ? [{ at: r.offset || 0, from: 0, len: r.duration || duration }]
        : r.regions.map((g) => ({ at: g.at, from: g.from || 0, muted: !!g.muted, len: g.len ?? Math.max(0, (r.duration || duration) - (g.from || 0)) }));
    pieces.forEach((pc, pi) => {
      // On whole pixels, as the grid lines: a clip on a beat starts on its line.
      const cx = Math.round(x(pc.at));
      const cw = Math.round(x(pc.at + pc.len)) - cx;
      if (cx > width || cx + cw < 0 || cw <= 0) return;
      const color = pc.muted ? '#64748b' : r.color;
      ctx.fillStyle = `${color}38`;
      ctx.fillRect(cx, y + 3, cw, LANE_H - 6);
      ctx.fillStyle = color;
      ctx.fillRect(cx, y + 3, cw, 14);
      // Segment being dragged (amber) or selected (white); a selected track without a segment is outlined faintly.
      const outline = r.dragIndex === pi ? '#fbbf24' : r.selected === pi ? '#f8fafc' : r.selected === -1 ? 'rgba(248,250,252,0.35)' : null;
      if (outline) {
        ctx.strokeStyle = outline;
        ctx.lineWidth = r.selected === pi ? 2 : 1;
        ctx.strokeRect(cx + 1, y + 4, cw - 2, LANE_H - 8);
        ctx.lineWidth = 1;
      }
      ctx.font = '700 10px Inter, sans-serif';
      ctx.fillStyle = '#0b0f17';
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(cx, 0), y + 3, Math.min(cw, width), 14);
      ctx.clip();
      ctx.fillText(r.name, Math.max(cx, 0) + 5, y + 10.5);
      ctx.restore();
      const p = r.local && peaks[r.local];
      if (r.kind === 'audio' && p) {
        const mid = y + 17 + (LANE_H - 20) / 2;
        const amp = (LANE_H - 24) / 2;
        const fileStart = pc.at - pc.from; // song time of second 0 of the file
        ctx.fillStyle = r.muted || pc.muted ? 'rgba(148,163,184,0.45)' : `${color}e6`;
        const x0 = Math.max(0, Math.floor(cx));
        const x1 = Math.min(width, Math.ceil(cx + cw));
        for (let px = x0; px < x1; px += 1) {
          const a = Math.floor((tStart + px / pps - fileStart) * p.pps);
          const b = Math.max(a + 1, Math.floor((tStart + (px + 1) / pps - fileStart) * p.pps));
          let v = 0;
          for (let k = Math.max(0, a); k < Math.min(p.peaks.length, b); k += 1) v = Math.max(v, p.peaks[k]);
          const h = (v / 255) * amp;
          if (h > 0.3) ctx.fillRect(px, mid - h, 1, h * 2);
        }
      } else if (r.kind === 'video') {
        ctx.fillStyle = 'rgba(224,79,208,0.25)';
        for (let fx = Math.max(cx, 0); fx < Math.min(cx + cw, width); fx += 48) {
          ctx.fillRect(fx + 4, y + 22, 40, LANE_H - 30);
        }
      }
    });
  });

  if (warp) drawWarp(ctx, { width, height, x, tStart, tEnd, rows, warp });
}

// Grid editing: analysis range, transients of the reference track, anchors.
function drawWarp(ctx, { width, height, x, tStart, tEnd, rows, warp }) {
  const { grid, onsets, refStemId, drag } = warp;
  ctx.fillStyle = 'rgba(3,6,12,0.55)';
  if (grid.from != null && grid.from > tStart) ctx.fillRect(0, RULER_H, Math.min(width, x(grid.from)), height - RULER_H);
  if (grid.to != null && grid.to < tEnd) ctx.fillRect(Math.max(0, x(grid.to)), RULER_H, width, height - RULER_H);
  [
    [grid.from, 1],
    [grid.to, -1],
  ].forEach(([t, dir]) => {
    if (t == null) return;
    const bx = Math.round(x(t)) + 0.5;
    ctx.strokeStyle = '#22d3ee';
    ctx.beginPath();
    ctx.moveTo(bx + dir * 6, 2);
    ctx.lineTo(bx, 2);
    ctx.lineTo(bx, height);
    ctx.stroke();
  });

  const ri = rows.findIndex((r) => r.stem?.id === refStemId);
  if (ri >= 0 && onsets) {
    const y = RULER_H + ri * LANE_H;
    ctx.fillStyle = 'rgba(248,250,252,0.55)';
    onsets.forEach((t) => {
      if (t < tStart || t > tEnd) return;
      ctx.fillRect(Math.round(x(t)), y + LANE_H - 12, 1, 9);
    });
  }

  grid.anchors.forEach((a) => {
    const ax = Math.round(x(a.t)) + 0.5;
    if (ax < -10 || ax > width + 10) return;
    ctx.strokeStyle = 'rgba(245,158,11,0.75)';
    ctx.beginPath();
    ctx.moveTo(ax, RULER_H);
    ctx.lineTo(ax, height);
    ctx.stroke();
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(ax, 15);
    ctx.lineTo(ax + 6, 22);
    ctx.lineTo(ax, 29);
    ctx.lineTo(ax - 6, 22);
    ctx.fill();
  });

  if (drag) {
    const dx = Math.round(x(drag.t)) + 0.5;
    ctx.strokeStyle = drag.snapped ? '#22d3ee' : '#fbbf24';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(dx, 0);
    ctx.lineTo(dx, height);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

// Toolbar of the grid editor: analysis range, manual tempo, tap, reset.
function GridBar({ grid, tempo, onChange }) {
  const taps = useRef([]);
  const [tapped, setTapped] = useState(null);
  const seg = tempo?.segments?.find((s) => !s.countIn);
  const single = grid.anchors.length <= 1;
  const shownBpm = single ? grid.bpm ?? seg?.bpm : null;
  const [bpmText, setBpmText] = useState('');
  useEffect(() => setBpmText(shownBpm ? String(Math.round(shownBpm * 100) / 100) : ''), [shownBpm]);

  // A manual tempo pins bar 1 where it is now (or keeps the single anchor).
  const setBpm = (bpm) => {
    if (!(bpm >= 20 && bpm <= 400)) return;
    const anchors = grid.anchors.length ? grid.anchors : [{ beat: 0, t: tempo?.origin ?? 0 }];
    onChange({ ...grid, anchors, bpm });
  };
  const tap = () => {
    const now = performance.now() / 1000;
    if (now - (taps.current.at(-1) ?? 0) > 2) taps.current = [];
    taps.current = [...taps.current, now];
    const bpm = tapBpm(taps.current);
    setTapped(bpm ? null : taps.current.length);
    if (bpm) setBpm(bpm);
  };
  const here = () => Math.max(0, Math.round(livePosition() * 100) / 100);

  return (
    <div className="arr-toolbar grid-bar">
      <span className="small faint">Analisi da</span>
      <button className="btn btn-sm" onClick={() => onChange({ ...grid, from: here() })} title="L’analisi automatica parte dalla posizione della testina (dove inizia il ritmo utile)">
        {grid.from != null ? fmtTime(grid.from) : 'inizio'}
      </button>
      {grid.from != null && (
        <button className="toggle" onClick={() => onChange({ ...grid, from: null })} title="Dall’inizio della traccia">
          <Icon name="x" size={10} />
        </button>
      )}
      <span className="small faint">a</span>
      <button className="btn btn-sm" onClick={() => onChange({ ...grid, to: here() })} title="L’analisi automatica si ferma alla posizione della testina">
        {grid.to != null ? fmtTime(grid.to) : 'fine'}
      </button>
      {grid.to != null && (
        <button className="toggle" onClick={() => onChange({ ...grid, to: null })} title="Fino alla fine della traccia">
          <Icon name="x" size={10} />
        </button>
      )}
      <span className="t-sep" style={{ height: 18 }} />
      <label className="small faint grid-bpm" title={single ? 'Tempo della griglia (fissa la battuta 1 dove si trova ora)' : 'Con più ancoraggi il tempo segue gli ancoraggi'}>
        BPM
        <input
          className="input se-tiny"
          value={single ? bpmText : ''}
          placeholder={single ? '' : 'var.'}
          disabled={!single}
          inputMode="decimal"
          onChange={(e) => setBpmText(e.target.value)}
          onBlur={() => setBpm(Number(bpmText.replace(',', '.')))}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
      <button className="btn btn-sm" onClick={tap} disabled={!single} title="Batti il tempo (almeno 3 colpi)">
        Tap{tapped ? ` ${tapped}` : ''}
      </button>
      <span className="t-sep" style={{ height: 18 }} />
      <span className="small muted">
        {grid.anchors.length ? `${grid.anchors.length} ancoraggi` : 'Griglia automatica'}
      </span>
      {(grid.anchors.length > 0 || grid.bpm) && (
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => confirm('Togliere ancoraggi e tempo manuale? La griglia torna a quella automatica.') && onChange({ ...grid, anchors: [], bpm: null })}
        >
          <Icon name="undo" size={13} /> Automatica
        </button>
      )}
      <span className="grow" />
      <span className="small faint grid-hint">
        Trascina una linea sul colpo · <b>Ctrl</b> sposta tutto · <b>Shift</b> senza calamita · doppio clic fissa · <b>Alt</b>+clic toglie
      </span>
    </div>
  );
}

function TrackHeader({ row, index, solos, onTrack, channels, selected, onSelect }) {
  if (row.kind === 'click') {
    return (
      <div className="t-header" style={{ '--lane-color': ROLE_COLORS.click }}>
        <span className="t-color" />
        <span className="t-name">Click · Tempo</span>
        <span className="t-btns">
          <button className={`toggle ${row.enabled ? 'is-on' : ''}`} onClick={row.onToggle}>
            On
          </button>
        </span>
        <div className="t-row small muted">{row.info}</div>
      </div>
    );
  }
  if (row.kind === 'video') {
    return (
      <div className="t-header" style={{ '--lane-color': ROLE_COLORS.video }}>
        <span className="t-color" />
        <span className="t-name">{row.name}</span>
        <span className="t-btns">
          <button className="toggle" onClick={row.onOutput} title="Apri l’uscita video (proiettore / secondo schermo)">
            <Icon name="monitor" size={12} />
          </button>
        </span>
        <div className="t-row small muted">Video · offset {(row.offset || 0).toFixed(2)} s</div>
      </div>
    );
  }
  const { stem } = row;
  const m = getMix(stem.id);
  const gain = m.gainDb ?? stem.gain ?? 0;
  const mute = m.mute ?? !!stem.muted;
  const route = m.route || null;
  return (
    <div className={`t-header ${selected ? 'is-selected' : ''}`} style={{ '--lane-color': row.color }} onMouseDown={onSelect} title="Clic: seleziona la traccia (Ctrl+E taglia nel punto del cursore)">
      <span className="t-color" />
      <span className="t-name" title={stem.file}>
        {stem.name}
      </span>
      <span className="t-btns">
        <button className={`toggle mute ${mute ? 'is-on' : ''}`} onClick={() => onTrack(stem, { mute: !mute })}>
          M
        </button>
        <button className={`toggle solo ${solos[stem.id] ? 'is-on' : ''}`} onClick={() => onTrack(stem, { solo: !solos[stem.id] })}>
          S
        </button>
      </span>
      <div className="t-row">
        <input
          className="slider"
          type="range"
          min={-60}
          max={6}
          step={0.5}
          value={gain}
          onChange={(e) => onTrack(stem, { gainDb: Number(e.target.value) })}
          onDoubleClick={() => onTrack(stem, { gainDb: 0 })}
          title={`${gain.toFixed(1)} dB`}
        />
        <select
          className="select-xs"
          value={route ? routeValue(route) : 'role'}
          onChange={(e) => onTrack(stem, { route: e.target.value === 'role' ? null : parseRoute(e.target.value) })}
          title="Uscita"
        >
          <option value="role">Ruolo ({stem.role || 'main'})</option>
          {outputOptions(channels).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Meter track={index} horizontal />
      </div>
    </div>
  );
}

export default function ArrangementView({ player, item, lanes, settings, update, onVideoOutput, canEdit, setlistId, notify }) {
  const loaded = player.loaded;
  const peaks = usePeaks();
  useMix();
  const channels = useEngineStatus((s) => s.device?.channels ?? 2);
  const scroller = useRef(null);
  const canvas = useRef(null);
  const playhead = useRef(null);
  const [view, setView] = useState({ width: 800, scroll: 0 });
  const [editing, setEditing] = useState(false); // grid editor (W)
  const [drag, setDrag] = useState(null); // { t, snapped } of the grid line being dragged
  const [draft, setDraft] = useState(null); // grid shown while dragging, before saving
  const grid = draft || gridOf(player.loadedItem);
  const warpOn = editing && canEdit && !!loaded;
  const refTrack = loaded && (loaded.tracks.find((t) => t.stem.id === loaded.sync?.source?.id) || loaded.tracks[0]);
  const onsets = useOnsets(warpOn ? refTrack?.local : null);
  const previewing = useRef(null);
  const pps = settings.pxPerSec;
  const tempo = loaded?.tempo;
  const t0 = -(tempo?.preRoll || 0) - 1;
  const duration = Math.max(loaded?.duration || 0, 10);
  const contentW = (duration - t0 + 20) * pps;
  const cue = useCueTrack({ player, setlistId, canEdit, notify });
  const nowCue = useNowCue(cue.bars, loaded?.itemId);
  const [cueHover, setCueHover] = useState(null); // g of the square under the pointer
  const [picking, setPicking] = useState(null); // { cell, beats, rect }
  const [cueDrag, setCueDrag] = useState(null); // beats the cue track is moved by while dragging
  const [addOpen, setAddOpen] = useState(false);
  const [barsOpen, setBarsOpen] = useState(false); // "Aggiungi → Battute" dialog
  const [clipDrag, setClipDrag] = useState(null); // { stemId, index, delta } moving a segment, { stemId, index, edge, t } trimming it
  const [selection, setSelection] = useState(null); // { stemId, index: segment or null }
  const snap = settings.snapGrid !== false;
  const song = player.loadedItem;
  const history = useHistory(song?.id);
  const traveling = useRef(false);
  const cutKey = useRef(); // Ctrl+E
  const deleteKey = useRef(); // Canc / Backspace
  const muteKey = useRef(); // X
  const toolKey = useRef(); // 1-5
  const saveKey = useRef(); // Ctrl+S
  const canEditSong = cue.canEdit;
  const dirty = !!useDrafts()[song?.id];
  const [saving, setSaving] = useState(false);
  const tool = TOOLS.some(([k]) => k === settings.arrTool) ? settings.arrTool : 'select';

  const rows = [];
  if (loaded?.video) rows.push({ kind: 'video', name: loaded.video.name, offset: loaded.video.offset, duration: loaded.duration, color: ROLE_COLORS.video, onOutput: onVideoOutput });
  loaded?.tracks.forEach((t, i) =>
    // The audio of the cues is mixed from the cue track's header.
    !(cue.exists && i === cue.audioIndex) &&
    rows.push({
      kind: 'audio',
      stem: t.stem,
      index: i,
      name: t.stem.name,
      local: t.local,
      duration: t.info?.duration,
      color: laneColor(lanes, t.stem),
      muted: getMix(t.stem.id).mute ?? !!t.stem.muted,
      regions: t.stem.live
        ? stemRegions(null, '')
        : clipDrag?.stemId === t.stem.id
          ? clipDrag.edge
            ? trimSegment(stemRegions(song, t.stem.id), clipDrag.index, clipDrag.edge, clipDrag.t, t.info?.duration || duration)
            : moveSegment(stemRegions(song, t.stem.id), clipDrag.index, clipDrag.delta)
          : stemRegions(song, t.stem.id),
      dragIndex: clipDrag?.stemId === t.stem.id ? clipDrag.index : -1,
      selected: selection?.stemId === t.stem.id ? selection.index ?? -1 : null,
    }),
  );
  if (loaded && cue.exists) rows.push({ kind: 'cue' });
  if (loaded) {
    const seg = tempo?.segments?.find((s) => !s.countIn);
    rows.push({
      kind: 'click',
      enabled: settings.click.enabled,
      onToggle: () => update({ click: { ...settings.click, enabled: !settings.click.enabled } }),
      info: seg ? `${Math.round(seg.bpm * 100) / 100} BPM · ${seg.timeSig}` : '',
    });
  }
  const height = RULER_H + rows.length * LANE_H;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const sync = () => setView({ width: el.clientWidth, scroll: el.scrollLeft });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    el.addEventListener('scroll', sync, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', sync);
    };
  }, [loaded]);

  useEffect(() => {
    if (canvas.current) {
      const warp = warpOn ? { grid, onsets, refStemId: refTrack?.stem.id, drag } : null;
      const byG = cueDrag ? new Map(cue.shifted(cueDrag).map((c) => [c.g, c.label])) : cue.byG;
      const cueDraw = { bars: cue.bars, byG, status: cue.busy || cue.status, hover: cueDrag ? null : cueHover, nowG: nowCue };
      draw(canvas.current, { width: view.width, height, scroll: view.scroll, pps, t0, tempo, rows, peaks, duration, warp, cue: cueDraw });
    }
  });

  // The draft is dropped once the song (or the stored grid) changes.
  const storedGrid = JSON.stringify(player.loadedItem?.grid ?? null);
  useEffect(() => setDraft(null), [storedGrid, loaded?.itemId]);
  useEffect(() => setSelection(null), [loaded?.itemId]);

  // W: grid editor on/off. Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y): undo / redo. Ctrl+E: cut the selected track.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        const dir = k === 'z' ? (e.shiftKey ? 1 : -1) : k === 'y' ? 1 : 0;
        if (dir) {
          e.preventDefault();
          historyKeys.current?.(dir);
        } else if (k === 'e') {
          e.preventDefault();
          cutKey.current?.();
        } else if (k === 's') {
          e.preventDefault();
          saveKey.current?.();
        }
        return;
      }
      if (e.altKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteKey.current?.();
        return;
      }
      if (e.key === 'w' || e.key === 'W') setEditing((v) => !v);
      const t = TOOLS.find((x) => x[3] === e.key);
      if (t) toolKey.current?.(t[0]);
      if (e.key === 'x' || e.key === 'X') muteKey.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Grid set by hand: applied at once here, on every computer once saved.
  const commitGrid = (next) => {
    setDraft(next);
    player.previewGrid(next);
    recordStep(song.id, { label: 'Griglia modificata', before: { media: {}, item: { grid: song.grid ?? null } }, after: { media: {}, item: { grid: next } } });
    player.saveGrid(next);
  };

  // Undo (dir -1) / redo (dir 1) of the edits of this song (lib/arrangeHistory).
  const goHistory = async (dir) => {
    if (!song || !cue.canEdit || traveling.current) return;
    traveling.current = true;
    try {
      const res = await travel(song, dir);
      if (!res) return;
      const { step, item: now } = res;
      if (step.reload) {
        const at = engineStatus().position;
        await player.load(now);
        player.locate(at);
      } else if ('regions' in step.after.media) {
        await player.applyRegions(now, Object.fromEntries(stemsOf(now).map((s) => [s.id, regionsOf(now)[s.id] || []])));
      }
      notify(`${dir < 0 ? 'Annullato' : 'Ripetuto'}: ${step.label}`);
    } catch (e) {
      notify(`${dir < 0 ? 'Annulla' : 'Ripeti'} non riuscito: ${e.message || e}`, true);
    } finally {
      traveling.current = false;
    }
  };

  // ---------- Draft of the song: save / discard ----------

  const saveSong = async () => {
    if (!song || !dirty || saving) return;
    setSaving(true);
    try {
      await saveDraft(setlistId, song);
      notify(`Salvato “${song.title}”`);
    } catch (e) {
      notify(`“${song.title}” non salvato: ${e.message || e}`, true);
    } finally {
      setSaving(false);
    }
  };
  saveKey.current = saveSong;
  const discardSong = () => {
    if (!song || !dirty || !confirm(`Scartare le modifiche non salvate di “${song.title}”? Torna com’era all’ultimo salvataggio.`)) return;
    discardDraft(song.id);
    clearHistory(song.id);
    player.reload();
    notify(`Modifiche di “${song.title}” scartate`);
  };

  // ---------- Segments of the tracks: select, move, cut, delete ----------
  const fileSeconds = (stemId) => loaded?.tracks.find((tr) => tr.stem.id === stemId)?.info?.duration || duration;
  const segmentAt = (row, t) => segmentIndexAt(row.regions, t, row.duration || duration);

  // Start or end of a segment under the pointer (a few pixels around it): { index, edge } or null.
  const edgeAt = (row, t) => {
    const tol = 6 / pps;
    let best = null;
    row.regions.forEach((g, index) => {
      const start = g.at;
      const end = segmentEnd(g, row.duration || duration);
      if ((end - start) * pps < 12) return;
      [
        ['start', start],
        ['end', end],
      ].forEach(([edge, et]) => {
        if (Math.abs(t - et) > tol) return;
        // Where two segments touch, the one under the pointer wins.
        const inside = edge === 'start' ? t >= et : t < et;
        const d = Math.abs(t - et) - (inside ? tol : 0);
        if (!best || d < best.d) best = { index, edge, d, t: et };
      });
    });
    return best;
  };
  const trimmable = (row) => row?.kind === 'audio' && !row.stem.live && canEditSong && (tool === 'select' || tool === 'move');

  // New regions of one track: into the song's draft, undoable, heard at once.
  // The grid stays where it is even when the edited track is its reference.
  const commitRegions = (stem, regions, label) => {
    let all = { ...regionsOf(song), [stem.id]: regions };
    if (stem.id === loaded?.sync?.source?.id) all = keepGrid(all, stemRegions(song, stem.id), stem.id);
    editDraft(song.id, { media: { regions: all } });
    recordStep(song.id, { label, before: { media: { regions: song.regions ?? null }, item: {} }, after: { media: { regions: all }, item: {} } });
    player.applyRegions({ ...song, regions: all }, { [stem.id]: regions });
    notify(label);
  };

  const selectedStem = selection && stemsOf(song).find((s) => s.id === selection.stemId);

  // Cut the selected track where the playhead is: two segments.
  const cutSelected = () => {
    if (!canEditSong || !song) return;
    if (!selectedStem) {
      notify('Seleziona una traccia (clic su una clip o sul nome) per tagliarla nel punto del cursore', true);
      return;
    }
    const t = engineStatus().position;
    const res = cutAt(stemRegions(song, selectedStem.id), t, fileSeconds(selectedStem.id));
    if (!res) {
      notify(`Il cursore non è sopra una clip di “${selectedStem.name}”`, true);
      return;
    }
    commitRegions(selectedStem, res.regions, `Tagliata “${selectedStem.name}” a ${fmtTime(Math.max(0, t))}`);
    setSelection({ stemId: selectedStem.id, index: res.index });
  };

  const deleteSelected = () => {
    if (!canEditSong || !selectedStem || selection.index == null) return;
    commitRegions(selectedStem, removeSegment(stemRegions(song, selectedStem.id), selection.index), `Eliminato un segmento di “${selectedStem.name}”`);
    setSelection({ stemId: selectedStem.id, index: null });
  };
  cutKey.current = cutSelected;
  deleteKey.current = deleteSelected;
  const muteSelected = () => {
    if (!canEditSong || !selectedStem || selection.index == null) return;
    const regions = stemRegions(song, selectedStem.id);
    const muted = !regions[selection.index]?.muted;
    commitRegions(selectedStem, toggleSegmentMute(regions, selection.index), `${muted ? 'Mutato' : 'Riattivato'} un segmento di “${selectedStem.name}”`);
  };
  muteKey.current = muteSelected;
  toolKey.current = (k) => update({ arrTool: k });
  const historyKeys = useRef();
  historyKeys.current = goHistory;

  // Engine preview while dragging, at most once per frame.
  const preview = (next) => {
    setDraft(next);
    const pending = previewing.current;
    previewing.current = next;
    if (pending) return;
    requestAnimationFrame(() => {
      const g = previewing.current;
      previewing.current = null;
      if (g) player.previewGrid(g);
    });
  };

  // Grid line (beat counted from bar 1) under the pointer, or an anchor.
  const lineAt = (t) => {
    const tol = 6 / pps;
    const a = grid.anchors.find((x) => Math.abs(x.t - t) <= tol);
    if (a) return { g: a.beat, t: a.t, anchor: true };
    let best = null;
    gridBeats(tempo, t - tol, t + tol).forEach((b) => {
      if (b.g == null) return;
      if (!best || Math.abs(b.t - t) < Math.abs(best.t - t)) best = { g: b.g, t: b.t };
    });
    return best && Math.abs(best.t - t) <= tol ? best : null;
  };

  // Square of the cue track under the pointer (null elsewhere).
  const cueHit = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const row = rows[Math.floor((e.clientY - rect.top - RULER_H) / LANE_H)];
    if (row?.kind !== 'cue' || warpOn) return null;
    return cueCellAt(cue.bars, (e.clientX - rect.left) / pps + t0);
  };

  const onMouseMove = (e) => {
    const hit = cue.canEdit ? cueHit(e) : null;
    const box = e.currentTarget.getBoundingClientRect();
    const row = !hit && !warpOn ? rows[Math.floor((e.clientY - box.top - RULER_H) / LANE_H)] : null;
    const pt = (e.clientX - box.left) / pps + t0;
    const onSegment = row?.kind === 'audio' && !row.stem.live && segmentAt(row, pt) >= 0;
    const onEdge = trimmable(row) && !!edgeAt(row, pt);
    const toolCursor = TOOLS.find(([k]) => k === tool)[4];
    const cueCursor = tool === 'move' ? 'grab' : tool === 'erase' ? 'not-allowed' : 'pointer';
    e.currentTarget.style.cursor = hit ? cueCursor : onEdge ? 'ew-resize' : onSegment && (canEditSong || tool === 'select') ? toolCursor : '';
    const g = hit?.cell.g ?? null;
    if (g !== cueHover) setCueHover(g);
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = (e.clientX - rect.left) / pps + t0;
    const hit = cue.canEdit ? cueHit(e) : null;
    if (hit) {
      const open = () => setPicking({ ...hit, rect: { left: e.clientX - 20, bottom: e.clientY + 8 } });
      // Eraser: removes the cue of the square.
      if (tool === 'erase') {
        if (cue.byG.has(hit.cell.g)) cue.setCue(hit.cell.g, null);
        return;
      }
      if (tool !== 'move' || !cue.cues.length) {
        open();
        return;
      }
      // Hand: the whole cue track moves square by square (a click without dragging opens the menu).
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      let delta = null;
      const move = (ev) => {
        if (delta == null && Math.abs(ev.clientX - x0) < 3) return;
        const at = cueCellAt(cue.bars, (ev.clientX - rect.left) / pps + t0);
        if (!at) return;
        delta = at.cell.g - hit.cell.g;
        setCueDrag(delta);
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        setCueDrag(null);
        if (delta == null) open();
        else cue.shift(delta);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      return;
    }
    // Segments of the tracks, by tool (Cubase style): arrow selects, hand
    // moves (on the beats with "Griglia", Shift = the other way), scissors
    // cut where clicked, X mutes / unmutes, eraser deletes.
    const row = rows[Math.floor((e.clientY - rect.top - RULER_H) / LANE_H)];
    // Start or end of a segment (arrow or hand): drag to trim it, the audio stays where it is.
    const trim = !warpOn && trimmable(row) ? edgeAt(row, t) : null;
    if (trim) {
      const stem = row.stem;
      setSelection({ stemId: stem.id, index: trim.index });
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const fileSec = row.duration || duration;
      let to = null;
      const move = (ev) => {
        if (to == null && Math.abs(ev.clientX - x0) < 3) return;
        const raw = trim.t + (ev.clientX - x0) / pps;
        to = snap !== ev.shiftKey && tempo ? snapToBeat(tempo, raw) : raw;
        setClipDrag({ stemId: stem.id, index: trim.index, edge: trim.edge, t: to });
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        setClipDrag(null);
        if (to == null || Math.abs(to - trim.t) < 1e-4) return;
        const regions = stemRegions(song, stem.id);
        const next = trimSegment(regions, trim.index, trim.edge, to, fileSec);
        if (JSON.stringify(next) === JSON.stringify(regions)) return;
        commitRegions(stem, next, `Accorciato${trim.edge === 'start' ? ' l’inizio' : ' la fine'} di un segmento di “${stem.name}”`);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      return;
    }
    const index = row?.kind === 'audio' && !row.stem.live ? segmentAt(row, t) : -1;
    if (index >= 0 && !warpOn) {
      const stem = row.stem;
      setSelection({ stemId: stem.id, index });
      if (tool === 'select') return;
      if (!canEditSong) {
        notify('Solo chi può modificare il brano può spostare, tagliare o mutare le tracce', true);
        return;
      }
      const regions = stemRegions(song, stem.id);
      if (tool === 'cut') {
        const at = snap !== e.shiftKey && tempo ? snapToBeat(tempo, t) : t;
        const res = cutAt(regions, at, row.duration || duration);
        if (!res) return;
        commitRegions(stem, res.regions, `Tagliata “${stem.name}” a ${fmtTime(Math.max(0, at))}`);
        setSelection({ stemId: stem.id, index: res.index });
        return;
      }
      if (tool === 'mute') {
        const muted = !regions[index].muted;
        commitRegions(stem, toggleSegmentMute(regions, index), `${muted ? 'Mutato' : 'Riattivato'} un segmento di “${stem.name}”`);
        return;
      }
      if (tool === 'erase') {
        commitRegions(stem, removeSegment(regions, index), `Eliminato un segmento di “${stem.name}”`);
        setSelection({ stemId: stem.id, index: null });
        return;
      }
      // Hand: drag to move the segment.
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const piece = row.regions[index];
      let delta = null;
      const move = (ev) => {
        if (delta == null && Math.abs(ev.clientX - x0) < 3) return;
        const raw = (ev.clientX - x0) / pps;
        delta = snap !== ev.shiftKey && tempo ? snapToBeat(tempo, piece.at + raw) - piece.at : raw;
        setClipDrag({ stemId: stem.id, index, delta });
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        setClipDrag(null);
        if (delta == null || Math.abs(delta) < 1e-4) return;
        const ms = Math.round(delta * 1000);
        commitRegions(stem, moveSegment(stemRegions(song, stem.id), index, delta), `Spostato un segmento di “${stem.name}” (${ms > 0 ? '+' : ''}${ms} ms)`);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      return;
    }
    if (row?.kind === 'audio') setSelection(null);
    if (!warpOn) {
      player.locate(t);
      return;
    }
    const line = lineAt(t);
    if (e.altKey) {
      if (line?.anchor) commitGrid({ ...grid, anchors: removeAnchor(grid.anchors, line.g) });
      return;
    }
    if (!line) {
      player.locate(t);
      return;
    }
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, anchors: grid.anchors, origin: tempo?.origin ?? 0 };
    // A single anchor keeps the tempo the grid has now.
    const bpm = grid.bpm ?? tempo?.segments?.find((s) => !s.countIn)?.bpm ?? null;
    let next = null;
    const move = (ev) => {
      if (!next && Math.abs(ev.clientX - start.x) < 3) return;
      let nt = line.t + (ev.clientX - start.x) / pps;
      const snap = ev.shiftKey ? null : nearestOnset(onsets, nt, 10 / pps);
      if (snap != null) nt = snap;
      next = {
        ...grid,
        bpm,
        anchors: ev.ctrlKey ? shiftAnchors(start.anchors, nt - line.t, line.g, nt) : moveAnchor(start.anchors, line.g, nt, start.origin),
      };
      setDrag({ t: nt, snapped: snap != null });
      preview(next);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      setDrag(null);
      if (next) commitGrid(next);
      else player.locate(t);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  // Double click on a grid line: pin it where it is.
  const onDoubleClick = (e) => {
    if (!warpOn) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const line = lineAt((e.clientX - rect.left) / pps + t0);
    if (!line || line.anchor) return;
    const bpm = grid.bpm ?? tempo?.segments?.find((s) => !s.countIn)?.bpm ?? null;
    commitGrid({ ...grid, bpm, anchors: moveAnchor(grid.anchors, line.g, line.t, tempo?.origin) });
  };

  // Playhead and page-follow (Ableton style) at display rate.
  useEffect(() => {
    let raf;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = scroller.current;
      if (!el || !playhead.current) return;
      const px = (livePosition() - t0) * pps;
      playhead.current.style.transform = `translateX(${px}px)`;
      const s = engineStatus();
      if (settings.followPlayhead && s.playing && s.songId === loaded?.itemId) {
        const rel = px - el.scrollLeft;
        if (rel > el.clientWidth * 0.85 || rel < 0) el.scrollLeft = px - el.clientWidth * 0.15;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pps, t0, settings.followPlayhead, loaded]);

  const zoom = useCallback(
    (factor, anchorX) => {
      const el = scroller.current;
      if (!el) return;
      const next = Math.max(MIN_PPS, Math.min(MAX_PPS, pps * factor));
      const ax = anchorX ?? el.clientWidth / 2;
      const t = (el.scrollLeft + ax) / pps;
      update({ pxPerSec: next });
      requestAnimationFrame(() => {
        el.scrollLeft = t * next - ax;
      });
    },
    [pps, update],
  );

  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = scroller.current.getBoundingClientRect();
    zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - rect.left);
  };

  const fit = () => {
    const el = scroller.current;
    if (!el) return;
    update({ pxPerSec: Math.max(MIN_PPS, Math.min(MAX_PPS, (el.clientWidth - 40) / (duration - t0))) });
    el.scrollLeft = 0;
  };

  if (!loaded) {
    return (
      <div className="empty">
        <div>
          <Icon name="timeline" size={36} />
          <h2>Nessun brano nel player</h2>
          <p>Fai doppio clic su un brano o premi ▶ su una scena per caricarlo.</p>
          {item && (
            <button className="btn btn-primary" onClick={() => player.load(item)}>
              Carica “{item.title}”
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="arr">
      <div className="arr-toolbar">
        <strong className="ellipsis">{player.loadedItem?.title}</strong>
        <span className="small muted">
          {loaded.tracks.length} tracce{loaded.video ? ' · video' : ''}
        </span>
        <span className="t-sep" style={{ height: 18 }} />
        <SyncControl player={player} />
        <span className="arr-add">
          <button
            className={`btn btn-sm ${addOpen ? 'is-on' : ''}`}
            onClick={() => setAddOpen((v) => !v)}
            disabled={!cue.canEdit}
            title={cue.canEdit ? 'Aggiungi una traccia al brano' : 'Solo chi può modificare il brano'}
          >
            <Icon name="plus" size={13} /> Aggiungi
          </button>
          {addOpen && (
            <div className="arr-add-menu" role="menu" onMouseLeave={() => setAddOpen(false)}>
              <button
                role="menuitem"
                disabled={cue.exists}
                onClick={() => {
                  cue.add();
                  setAddOpen(false);
                }}
              >
                <span className="cue-badge">CUE</span>
                <span>
                  Traccia cue
                  <span className="small faint">{cue.exists ? 'Già presente nel brano' : 'Guide vocali sulle battute (Chorus, Bridge, 1-2-3-4…)'}</span>
                </span>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setAddOpen(false);
                  setBarsOpen(true);
                }}
              >
                <Icon name="plus" size={13} />
                <span>
                  Battute…
                  <span className="small faint">Inserisce battute vuote dalla posizione attuale: le tracce dopo si spostano</span>
                </span>
              </button>
            </div>
          )}
        </span>
        <button
          className={`btn btn-sm ${snap ? 'is-on' : ''}`}
          onClick={() => update({ snapGrid: !snap })}
          title={snap ? 'Griglia attiva: le tracce trascinate si agganciano ai movimenti (Shift = libero)' : 'Griglia spenta: le tracce si spostano liberamente (Shift = aggancia)'}
        >
          <Icon name="grid" size={13} /> Griglia
        </button>
        <span className="t-sep" style={{ height: 18 }} />
        <button
          className="btn btn-sm btn-icon"
          onClick={() => goHistory(-1)}
          disabled={!canEditSong || !history.past.length}
          title={history.past.length ? `Annulla: ${history.past.at(-1).label} (Ctrl+Z)` : 'Niente da annullare'}
        >
          <Icon name="undo" size={14} />
        </button>
        <button
          className="btn btn-sm btn-icon"
          onClick={() => goHistory(1)}
          disabled={!canEditSong || !history.future.length}
          title={history.future.length ? `Ripeti: ${history.future.at(-1).label} (Ctrl+Shift+Z)` : 'Niente da ripetere'}
        >
          <Icon name="undo" size={14} className="icon-flip" />
        </button>
        <span className="view-switch arr-tools" role="toolbar" aria-label="Strumenti">
          {TOOLS.map(([k, icon, label, key]) => (
            <button
              key={k}
              className={tool === k ? 'is-on' : ''}
              onClick={() => update({ arrTool: k })}
              disabled={k !== 'select' && !canEditSong}
              title={`${label} (${key})`}
            >
              <Icon name={icon} size={14} />
            </button>
          ))}
        </span>
        <button
          className={`btn btn-sm ${warpOn ? 'is-on' : ''}`}
          onClick={() => setEditing((v) => !v)}
          disabled={!canEdit}
          title={canEdit ? 'Allinea a mano griglia e click all’audio: ancoraggi, tempo, intervallo di analisi (W)' : 'Solo chi può modificare la scaletta'}
        >
          <Icon name="edit" size={13} /> Griglia a mano
        </button>
        <span className="grow" />
        {dirty && (
          <span className="arr-save">
            <span className="small arr-unsaved">Non salvato</span>
            <button className="btn btn-sm btn-ghost" onClick={discardSong} disabled={saving} title="Torna all’ultimo salvataggio">
              Scarta
            </button>
            <button className="btn btn-sm btn-primary" onClick={saveSong} disabled={saving} title="Salva le modifiche del brano per tutta la band (Ctrl+S)">
              <Icon name="check" size={13} /> {saving ? 'Salvataggio…' : 'Salva'}
            </button>
          </span>
        )}
        <button
          className={`btn btn-sm ${settings.followPlayhead ? 'is-on' : ''}`}
          onClick={() => update({ followPlayhead: !settings.followPlayhead })}
          title="Segui la testina"
        >
          <Icon name="follow" size={14} /> Segui
        </button>
        <button className="btn btn-sm btn-icon" onClick={() => zoom(1 / 1.5)} title="Riduci (Ctrl + rotella)">
          <Icon name="minus" size={14} />
        </button>
        <button className="btn btn-sm btn-icon" onClick={() => zoom(1.5)} title="Ingrandisci (Ctrl + rotella)">
          <Icon name="plus" size={14} />
        </button>
        <button className="btn btn-sm" onClick={fit} title="Adatta il brano alla finestra">
          <Icon name="maximize" size={14} /> Adatta
        </button>
        {loaded.video && (
          <button className="btn btn-sm" onClick={onVideoOutput}>
            <Icon name="monitor" size={14} /> Uscita video
          </button>
        )}
      </div>
      {warpOn && <GridBar grid={grid} tempo={tempo} onChange={commitGrid} />}
      <div className="arr-body">
        <div className="arr-timeline" ref={scroller} onWheel={onWheel}>
          <div
            className={`arr-content ${warpOn ? 'is-warp' : ''}`}
            style={{ width: contentW, height }}
            onPointerDown={onPointerDown}
            onDoubleClick={onDoubleClick}
            onMouseMove={onMouseMove}
            onMouseLeave={() => setCueHover(null)}
          >
            <canvas className="arr-canvas" ref={canvas} />
            <div className="arr-playhead" ref={playhead} style={{ height }} />
          </div>
        </div>
        <div className="arr-headers">
          <div className="arr-ruler-head">Tracce</div>
          {rows.map((r, i) =>
            r.kind === 'cue' ? (
              <CueHeader key="cue" cue={cue} solos={player.solos} onTrack={player.setTrack} loadedTracks={loaded.tracks} />
            ) : (
              <TrackHeader
                key={r.stem?.id || r.kind + i}
                row={r}
                index={r.index}
                solos={player.solos}
                onTrack={player.setTrack}
                channels={channels}
                selected={r.kind === 'audio' && selection?.stemId === r.stem.id}
                onSelect={r.kind === 'audio' && !r.stem.live ? () => setSelection((s) => (s?.stemId === r.stem.id ? s : { stemId: r.stem.id, index: null })) : undefined}
              />
            ),
          )}
        </div>
      </div>
      {barsOpen && <InsertBarsModal player={player} onClose={() => setBarsOpen(false)} notify={notify} />}
      {picking && (
        <CuePicker
          cell={picking.cell}
          rect={picking.rect}
          beatsInBar={picking.beats}
          current={cue.byG.get(picking.cell.g)}
          onPick={(label) => {
            cue.setCue(picking.cell.g, label);
            setPicking(null);
          }}
          onCount={() => {
            cue.countBar(picking.cell.bar);
            setPicking(null);
          }}
          onClear={() => {
            cue.setCue(picking.cell.g, null);
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
