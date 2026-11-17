import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animateWhilePlaying, engineStatus, livePosition, useEngineStatus } from '../lib/engine';
import { gridBeats, moveAnchor, nearestOnset, removeAnchor, shiftAnchors, tapBpm } from '../lib/grid';
import { laneColor, ROLE_COLORS } from '../lib/lanes';
import { usePeaks } from '../lib/mediaCache';
import { useOnsets } from '../lib/onsets';
import { nearestBarIndex, sectionIndexAt } from '../lib/sections';
import { useSections } from '../lib/useSections';
import { gridOf } from '../lib/sync';
import { getMix, useMix } from '../lib/settings';
import { toggleMixerWindow } from '../lib/useMixer';
import Icon from './Icon';
import { useOutputOpen } from '../lib/outputs';
import Meter from './Meter';
import SyncControl from './SyncControl';
import { CueHeader, cueCellAt, drawCueLane, useCueTrack, useNowCue } from './CueLane';
import { CuePicker } from './CuePicker';
import InsertBarsModal from './InsertBarsModal';
import { closeLeadingGap, leadToAudio, cutAt, keepGrid, moveSegment, removeSegment, segmentEnd, segmentIndexAt, snapToBeat, stemRegions, toggleSegmentMute, trimSegment } from '../lib/arrange';
import { clearHistory, recordStep, travel, useHistory } from '../lib/arrangeHistory';
import { discardDraft, editDraft, saveDraft, savedMessage, useDrafts, usePendingSaves } from '../lib/drafts';
import { AUTO_MAX_DB, AUTO_MIN_DB, automationDb, automationMutedAt, automationOf, automationRead, muteAutomationOf, muteSpans, regionsOf, stemsOf, VIDEO_AUDIO_ID, clickAutoOf, videoOf } from '../shared/media.js';
import { alignText, alignVideo, canAlignVideo } from '../lib/videoAlign';
import { CLICK_ID, clickHasAutomation, hasAutomation, setClickAutomation, setClickMute, setClickVolume, thinAutomation, toggleClickRead, toggleClickWrite, toggleRead, toggleWrite, useAutoWrite, writeClickMute, writeMute } from '../lib/autoWrite';
import { TIME_SIGNATURES } from '../shared/setlists.js';
import { cleanTempoChanges, MAX_BPM, MAX_RAMP, MIN_BPM, tempoChangesOf } from '../shared/tempoMap.js';
import { writeMix } from '../lib/songMix';
import Toolbar, { ToolGroup } from './Toolbar';
import { longPressed, openContextMenu } from './ContextMenu';
import { normalizePrompter, slideColor, slideName } from '../lib/prompter';
import { plainSlideText } from '../shared/prompter.js';

// The gobbo moved by `delta` seconds, all its changes together.
const shiftPrompter = (p, delta) => ({ ...p, cues: (p.cues || []).map((c) => ({ ...c, t: Math.round((c.t + delta) * 1000) / 1000 })) });

// Bar numbers on top, then the lane of the sections (Cubase's marker track).
const MARK_Y = 30;
const RULER_H = 56;
const MARK_EDGE = 6; // px around the start of a section where a drag moves it
const LANE_H = 64;
const MIN_PPS = 4;
const MAX_PPS = 400;
const DOUBLE_TAP = 400; // ms: dblclick never reaches a touch screen (tablet), two taps make one
const TAP_SLOP = 8; // px a finger may move and still be a tap, not a scroll

// Tools for the segments of the tracks (Cubase style), with their keys and cursors.
const TOOLS = [
  ['select', 'pointer', 'Selezione · trascina un bordo per accorciare il segmento', '1', 'default'],
  ['move', 'hand', 'Sposta: trascina il segmento intero, da qualsiasi punto', '2', 'grab'],
  ['cut', 'scissors', 'Taglia dove clicchi', '3', 'crosshair'],
  ['mute', 'x', 'Muta / riattiva un segmento', '4', 'pointer'],
  ['erase', 'eraser', 'Elimina un segmento', '5', 'not-allowed'],
  ['auto', 'automation', 'Automazione (tracce e click): clic aggiunge un punto del volume, trascina un punto per spostarlo, trascina la linea per alzarla o abbassarla, Alt+trascina disegna a mano, doppio clic o Alt+clic toglie un punto · Ctrl+clic muta o riattiva da lì, trascina la bandierina rossa per spostare un bordo del mute (Ctrl+clic la toglie)', '6', 'crosshair'],
];

// Volume automation drawn in the lane of a track, under the strip with the name: the
// height is a fader's (0 dB at about 4/5, +6 dB on top, silence at the bottom).
const AUTO_TOP = 19;
const AUTO_H = LANE_H - AUTO_TOP - 4;
const autoY = (db, y) => y + AUTO_TOP + (1 - (db <= AUTO_MIN_DB ? 0 : Math.cbrt(10 ** (db / 20) / 2))) * AUTO_H;
function autoDbAt(py, y) {
  const p = Math.max(0, Math.min(1, 1 - (py - y - AUTO_TOP) / AUTO_H));
  const g = 2 * p ** 3;
  return g <= 0.001 ? AUTO_MIN_DB : Math.max(AUTO_MIN_DB, Math.min(AUTO_MAX_DB, Math.round(20 * Math.log10(g) * 10) / 10));
}
const dbLabel = (db) => (db <= AUTO_MIN_DB ? '−∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1).replace('.', ',')} dB`);
const AUTO_HIT = 7; // px around a point that grab it

// A stroke drawn by hand (Alt+drag) in place of the points under it; the curve
// outside the stroke keeps its shape (a point of it on each side).
function mergeStroke(points, stroke) {
  if (!stroke.length) return points;
  const a = stroke[0].t;
  const b = stroke[stroke.length - 1].t;
  const out = points.filter((pt) => pt.t < a || pt.t > b);
  if (points.some((pt) => pt.t < a) && a > 0.03) out.push({ t: a - 0.02, db: automationDb(points, a - 0.02) });
  if (points.some((pt) => pt.t > b)) out.push({ t: b + 0.02, db: automationDb(points, b + 0.02) });
  return [...out, ...stroke].sort((x, y) => x.t - y.t);
}
const TEMPO_HIT = 8; // px around a tempo change that grab it

const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const gapText = ({ gap }) => (gap > 0 ? `tolti ${gap.toFixed(1)} s vuoti all’inizio` : 'battuta 1 riportata all’inizio, con le sue cue');

function draw(canvas, { width, height, scroll, pps, t0, tempo, rows, peaks, duration, warp, cue, sections, tempoLane, autoTool }) {
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

  // Section lane: a colour each, as in the Palco view.
  sections.forEach((s) => {
    const sx = x(s.start);
    const ex = x(s.end);
    if (ex < 0 || sx > width) return;
    ctx.fillStyle = `${s.color}40`;
    ctx.fillRect(sx, MARK_Y + 1, ex - sx, RULER_H - MARK_Y - 2);
    ctx.fillStyle = s.color;
    ctx.fillRect(sx, MARK_Y + 1, 1, RULER_H - MARK_Y - 2);
    ctx.beginPath();
    ctx.moveTo(sx - 5, MARK_Y + 1);
    ctx.lineTo(sx + 6, MARK_Y + 1);
    ctx.lineTo(sx + 0.5, MARK_Y + 9);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.rect(sx, MARK_Y, ex - sx, RULER_H - MARK_Y);
    ctx.clip();
    ctx.font = '700 11px Inter, sans-serif';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(s.label, Math.max(sx, 0) + 8, MARK_Y + (RULER_H - MARK_Y) / 2);
    ctx.restore();
    ctx.strokeStyle = `${s.color}80`;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(sx) + 0.5, RULER_H);
    ctx.lineTo(Math.round(sx) + 0.5, height);
    ctx.stroke();
    ctx.setLineDash([]);
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
    if (r.kind === 'prompter') {
      drawPrompterLane(ctx, { y, width, x, duration, ...r });
      return;
    }
    if (r.kind === 'click') {
      ctx.fillStyle = 'rgba(6,182,212,0.6)';
      beats.forEach((b) => {
        const h = b.inBar === 0 ? LANE_H - 18 : (LANE_H - 18) * 0.45;
        ctx.fillRect(Math.round(x(b.t)), y + LANE_H - 9 - h, 2, h);
      });
      drawTempoLane(ctx, { y, width, x, beats, ...tempoLane });
      if (r.auto?.length || r.muteAuto?.length || autoTool) drawAutomation(ctx, { y, width, tStart, tEnd, pps, x, points: r.auto || [], mutes: r.muteAuto || [], read: r.read !== false, active: autoTool });
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
    if (r.kind === 'audio' && r.auto && (r.auto.length || r.muteAuto?.length || (autoTool && !r.stem.live)))
      drawAutomation(ctx, { y, width, tStart, tEnd, pps, x, points: r.auto, mutes: r.muteAuto || [], read: r.read !== false, active: autoTool });
  });

  if (warp) drawWarp(ctx, { width, height, x, tStart, tEnd, rows, warp });
}

// Automation of a track: the spans its mute automation silences (dark, a red
// line under the name), the volume as a line over its clips, its points with the
// Automazione tool; dashed and faint with the R of the channel off (not played).
function drawAutomation(ctx, { y, width, tStart, tEnd, pps, x, points, mutes, read, active }) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y + 1, width, LANE_H - 2);
  ctx.clip();
  if (!read) {
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([4, 3]);
  }
  muteSpans(mutes).forEach(({ from, to }) => {
    if (to < tStart || from > tEnd) return;
    const x0 = Math.max(-2, x(from));
    const x1 = Math.min(width + 2, to === Infinity ? width + 2 : x(to));
    ctx.fillStyle = 'rgba(2,6,15,0.55)';
    ctx.fillRect(x0, y + AUTO_TOP - 2, x1 - x0, LANE_H - AUTO_TOP + 1);
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(x0, y + AUTO_TOP - 3, x1 - x0, 2);
  });
  if (active) {
    // The edges of the mute, grabbed by Ctrl+click.
    ctx.fillStyle = '#ef4444';
    mutes.forEach((m) => {
      const px = x(m.t);
      if (px < -6 || px > width + 6) return;
      ctx.beginPath();
      ctx.moveTo(px - 4, y + AUTO_TOP - 7);
      ctx.lineTo(px + 4, y + AUTO_TOP - 7);
      ctx.lineTo(px, y + AUTO_TOP - 1);
      ctx.fill();
    });
  }
  if (!points.length && mutes.length) {
    ctx.restore();
    return;
  }
  ctx.strokeStyle = active ? '#fbbf24' : 'rgba(251,191,36,0.6)';
  ctx.lineWidth = active ? 1.5 : 1;
  ctx.beginPath();
  for (let px = 0; px <= width; px += 2) {
    const py = autoY(automationDb(points, tStart + px / pps), y);
    if (px === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  if (active) {
    ctx.fillStyle = '#fbbf24';
    ctx.strokeStyle = '#0b0f17';
    ctx.lineWidth = 1;
    points.forEach((p) => {
      const px = x(p.t);
      if (px < -6 || px > width + 6) return;
      ctx.beginPath();
      ctx.rect(Math.round(px) - 3.5, Math.round(autoY(p.db, y)) - 3.5, 7, 7);
      ctx.fill();
      ctx.stroke();
    });
  }
  ctx.restore();
}

// Tempo changes in the lane of the click (Cubase's tempo track): the tempo as a line,
// a flag on each change with its BPM (and the bars of a gradual change).
function drawTempoLane(ctx, { y, width, x, beats, marks = [], range = [60, 180], open, drag }) {
  if (!marks.length && !drag) return;
  const [lo, hi] = range;
  const top = y + 20;
  const h = LANE_H - 32;
  const yOf = (bpm) => top + h - ((bpm - lo) / Math.max(1, hi - lo)) * h;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y + 1, width, LANE_H - 2);
  ctx.clip();
  ctx.strokeStyle = 'rgba(248,250,252,0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  beats
    .filter((b) => !b.seg.countIn)
    .forEach((b, i) => {
      const py = yOf(b.seg.bpm);
      if (i === 0) ctx.moveTo(x(b.t), py);
      else ctx.lineTo(x(b.t), py);
    });
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.font = '700 10px Inter, sans-serif';
  [...marks, ...(drag ? [drag] : [])].forEach((m) => {
    if (m.t == null) return;
    const mx = Math.round(x(m.t)) + 0.5;
    if (mx < -80 || mx > width + 10) return;
    const color = m === drag ? '#fbbf24' : open === m.bar ? '#f8fafc' : '#f59e0b';
    if (m.ramp && m.tEnd != null) {
      ctx.fillStyle = 'rgba(245,158,11,0.16)';
      ctx.fillRect(mx, y + 3, x(m.tEnd) - mx, LANE_H - 6);
    }
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(mx, y + 3);
    ctx.lineTo(mx, y + LANE_H - 3);
    ctx.stroke();
    const text = [m.bpm ? `♩ ${m.bpm}${m.ramp ? ` · ${m.ramp} bt` : ''}` : null, m.timeSig].filter(Boolean).join(' · ');
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = color;
    ctx.fillRect(mx, y + 3, w, 14);
    ctx.fillStyle = '#0b0f17';
    ctx.fillText(text, mx + 5, y + 10.5);
  });
  ctx.restore();
}

// Gobbo: one block per slide change, in the colour of the slide, up to the next change.
function drawPrompterLane(ctx, { y, width, x, duration, data, delta, dragging }) {
  const cues = data.cues;
  ctx.font = '700 10px Inter, sans-serif';
  cues.forEach((c, i) => {
    if (c.slide == null) return;
    const a = c.t + delta;
    const b = (cues[i + 1]?.t ?? Math.max(duration, c.t + 4)) + delta;
    const cx = Math.round(x(a));
    const cw = Math.round(x(b)) - cx;
    if (cx > width || cx + cw < 0 || cw <= 0) return;
    const color = slideColor(data.slides, c.slide) || '#94a3b8';
    ctx.fillStyle = `${color}38`;
    ctx.fillRect(cx, y + 3, cw, LANE_H - 6);
    ctx.fillStyle = color;
    ctx.fillRect(cx, y + 3, Math.min(cw, 3), LANE_H - 6);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx, y + 3, cw, LANE_H - 6);
    ctx.clip();
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(slideName(data.slides, c.slide), Math.max(cx, 0) + 7, y + 16);
    const text = plainSlideText(data.slides.find((sl) => sl.id === c.slide)?.text).split('\n')[0];
    ctx.font = '500 10px Inter, sans-serif';
    ctx.fillStyle = 'rgba(248,250,252,0.6)';
    ctx.fillText(text, Math.max(cx, 0) + 7, y + 31);
    ctx.font = '700 10px Inter, sans-serif';
    ctx.restore();
  });
  if (dragging) {
    ctx.strokeStyle = '#fbbf24';
    ctx.strokeRect(0.5, y + 2.5, width - 1, LANE_H - 5);
  }
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
  const shownBpm = single ? (grid.bpm ?? seg?.bpm) : null;
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
      <span className="small muted">{grid.anchors.length ? `${grid.anchors.length} ancoraggi` : 'Griglia automatica'}</span>
      {(grid.anchors.length > 0 || grid.bpm) && (
        <button className="btn btn-sm btn-ghost" onClick={() => confirm('Togliere ancoraggi e tempo manuale? La griglia torna a quella automatica.') && onChange({ ...grid, anchors: [], bpm: null })}>
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

// A tempo change of the lane Click · Tempo: its BPM, at once or gradually over some bars, remove.
const RAMPS = [0, 1, 2, 4, 8, 16];
// A change of tempo, of metre or both from a bar (shared/tempoMap.js): BPM empty = the tempo goes on as it is.
function TempoEditor({ mark, left, top, editable, ignored, onBpm, onRamp, onSig, onRemove, onClose }) {
  const shown = mark.bpm ? String(mark.bpm) : '';
  const [bpm, setBpm] = useState(shown);
  useEffect(() => setBpm(shown), [shown]);
  const apply = () => {
    const text = bpm.trim();
    // Empty: only the metre changes here (when there is one to keep).
    if (!text) {
      if (mark.bpm && mark.timeSig) onBpm(null);
      else setBpm(shown);
      return;
    }
    const v = Math.round(Number(text.replace(',', '.')) * 100) / 100;
    if (v >= MIN_BPM && v <= MAX_BPM && v !== mark.bpm) onBpm(v);
    else setBpm(shown);
  };
  const sigs = [...new Set([...TIME_SIGNATURES, ...(mark.timeSig ? [mark.timeSig] : [])])];
  const ramps = [...new Set([...RAMPS, mark.ramp])].filter((n) => n <= MAX_RAMP).sort((a, b) => a - b);
  return (
    <div
      className="arr-tempo-pop"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="arr-tempo-head">
        <strong>Cambio · battuta {mark.bar}</strong>
        <button className="toggle" onClick={onClose} aria-label="Chiudi">
          <Icon name="x" size={10} />
        </button>
      </div>
      <label className="small">
        BPM
        <input
          className="input se-tiny"
          value={bpm}
          placeholder="uguale"
          inputMode="decimal"
          disabled={!editable}
          onChange={(e) => setBpm(e.target.value)}
          onBlur={apply}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
      <label className="small">
        Arriva
        <select className="input se-tiny" value={mark.ramp} disabled={!editable || !mark.bpm} onChange={(e) => onRamp(Number(e.target.value))}>
          {ramps.map((n) => (
            <option key={n} value={n}>
              {n ? `gradualmente in ${n} ${n === 1 ? 'battuta' : 'battute'}` : 'subito'}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        Metro
        <select
          className="input se-tiny"
          value={mark.timeSig || ''}
          disabled={!editable}
          onChange={(e) => {
            const v = e.target.value || null;
            // Neither tempo nor metre left: nothing would change here.
            if (!v && !mark.bpm) return;
            onSig(v);
          }}
        >
          <option value="">{mark.bpm ? 'uguale' : '—'}</option>
          {sigs.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </label>
      {ignored && <p className="small faint">La griglia segue la traccia click o gli ancoraggi a mano: finché c’è, questo cambio non si sente.</p>}
      {editable && (
        <button className="btn btn-sm btn-ghost" onClick={onRemove}>
          <Icon name="trash" size={12} /> Togli
        </button>
      )}
    </div>
  );
}

// Volume, pan and destination of the tracks are in the Mixer (Dettaglio → Mixer, F3).
// saved: the mute of the tracks is the song's (who can edit it), not this computer's.
// M of a track lit by its mute automation where the song is now (R on, playing).
function useAutoMuted(row) {
  const on = (row.kind === 'audio' || row.kind === 'click') && row.read !== false && !!row.muteAuto?.length;
  return useEngineStatus((s) => on && s.playing && !s.waiting && automationMutedAt(row.muteAuto, Math.max(0, s.position)));
}

// auto: { song, canEdit } for R/W of the channel (as Cubase): R = its automations are played
// (saved with the song), W = while it plays its M (and its fader in the Mixer) writes them.
function TrackHeader({ row, index, solos, onTrack, selected, onSelect, saved, auto, onMenu }) {
  const autoMuted = useAutoMuted(row);
  if (row.kind === 'click') {
    return (
      <div className="t-header" style={{ '--lane-color': ROLE_COLORS.click }} onContextMenu={onMenu}>
        <span className="t-color" />
        <span className="t-name">Click · Tempo</span>
        <span className="t-btns">
          {row.onAddTempo && (
            <button className="toggle" onClick={row.onAddTempo} title="Cambio di tempo o di metro alla battuta della testina (doppio clic sulla corsia: nel punto scelto)" aria-label="Aggiungi un cambio di tempo">
              <Icon name="plus" size={11} />
            </button>
          )}
          <button
            className={`toggle ${row.enabled && !autoMuted ? 'is-on' : ''} ${row.enabled && autoMuted ? 'mute is-auto' : ''}`}
            onClick={() => (row.write && auto?.canEdit && writeClickMute(auto.song)) || row.onToggle()}
            title={
              row.write
                ? 'W attivo: mentre il brano suona, On ferma o fa ripartire il click da questo punto (automazione)'
                : autoMuted
                  ? 'Click fermato dall’automazione in questo punto'
                  : 'Click acceso o spento (per tutti i brani)'
            }
          >
            On
          </button>
          {auto && (
            <>
              <button
                className={`toggle read ${row.read !== false && row.hasAuto ? 'is-on' : ''}`}
                onClick={() => toggleClickRead(auto.song)}
                disabled={!auto.canEdit || !row.hasAuto}
                title={row.hasAuto ? `Lettura automazione del click (R): ${row.read !== false ? 'attiva, il click segue la curva del volume e tace nei tratti segnati' : 'spenta, il click suona sempre al suo volume'} · si salva con il brano` : 'Lettura automazione del click (R): nessuna automazione (lo strumento Automazione disegna volume e tratti senza click, W li scrive suonando)'}
              >
                R
              </button>
              <button
                className={`toggle write ${row.write ? 'is-on' : ''}`}
                onClick={() => toggleClickWrite(auto.song)}
                disabled={!auto.canEdit}
                title={auto.canEdit ? 'Scrittura automazione del click (W): mentre il brano suona, On ferma o fa ripartire il click in quel punto (poi “Salva”). Solo su questo dispositivo' : 'Solo chi può modificare il brano scrive le automazioni'}
              >
                W
              </button>
            </>
          )}
        </span>
        <div className="t-row small muted">
          <span className="ellipsis grow">{row.info}</span>
          <Meter click horizontal />
        </div>
      </div>
    );
  }
  if (row.kind === 'video') {
    return (
      <div className="t-header" style={{ '--lane-color': ROLE_COLORS.video }} onContextMenu={onMenu}>
        <span className="t-color" />
        <span className="t-name">{row.name}</span>
        <span className="t-btns">
          {row.onAlign && (
            <button className="toggle" onClick={row.onAlign} disabled={row.aligning} title="Sincronizza: confronta l’audio del video con le tracce e sposta il video nel punto giusto">
              <Icon name="wand" size={12} />
            </button>
          )}
          {row.onOutput && (
            <button className="toggle" onClick={row.onOutput} title="Apri l’uscita video (proiettore / secondo schermo)">
              <Icon name="monitor" size={12} />
            </button>
          )}
        </span>
        <div className="t-row small muted">{row.aligning ? 'Sincronizzo con le tracce…' : `Video · offset ${(row.offset || 0).toFixed(2)} s`}</div>
      </div>
    );
  }
  const { stem } = row;
  const own = saved ? !!stem.muted : (getMix(stem.id).mute ?? !!stem.muted);
  const mute = own || autoMuted;
  const rw = auto && !stem.live && stem.id !== VIDEO_AUDIO_ID;
  const can = rw && auto.canEdit;
  return (
    <div className={`t-header ${selected ? 'is-selected' : ''}`} style={{ '--lane-color': row.color }} onMouseDown={onSelect} onContextMenu={onMenu} title="Clic: seleziona la traccia (Ctrl+E taglia nel punto del cursore)">
      <span className="t-color" />
      <span className="t-name" title={stem.file}>
        {stem.name}
      </span>
      <span className="t-btns">
        <button
          className={`toggle mute ${mute ? 'is-on' : ''} ${autoMuted && !own ? 'is-auto' : ''}`}
          onClick={() => (can && writeMute(auto.song, stem)) || onTrack(stem, { mute: !own })}
          title={
            row.write
              ? 'Mute: W attivo, mentre il brano suona scrive l’automazione del mute'
              : autoMuted && !own
                ? 'Mutata dall’automazione in questo punto'
                : saved
                  ? 'Muta la traccia nel brano (per tutta la band, con “Salva”)'
                  : 'Muta la traccia su questo dispositivo'
          }
        >
          M
        </button>
        <button className={`toggle solo ${solos[stem.id] ? 'is-on' : ''}`} onClick={() => onTrack(stem, { solo: !solos[stem.id] })}>
          S
        </button>
        {rw && (
          <>
            <button
              className={`toggle read ${row.read !== false && row.hasAuto ? 'is-on' : ''}`}
              onClick={() => toggleRead(auto.song, stem)}
              disabled={!can || !row.hasAuto}
              title={row.hasAuto ? `Lettura automazione (R): ${row.read !== false ? 'attiva, volume e mute seguono le curve' : 'spenta, la traccia resta al fader'} · si salva con il brano` : 'Lettura automazione (R): la traccia non ha automazioni (W per scriverle, o lo strumento Automazione)'}
            >
              R
            </button>
            <button
              className={`toggle write ${row.write ? 'is-on' : ''}`}
              onClick={() => toggleWrite(auto.song, stem)}
              disabled={!can}
              title={can ? 'Scrittura automazione (W): mentre il brano suona, M di questa traccia e il suo fader nel Mixer scrivono l’automazione (poi “Salva”). Solo su questo dispositivo' : 'Solo chi può modificare il brano scrive le automazioni'}
            >
              W
            </button>
          </>
        )}
      </span>
      <div className="t-row">
        <Meter track={index} horizontal />
      </div>
    </div>
  );
}

// onMixer: the Mixer button (by default the F3 window of the desktop); null hides it (mobile: the Mixer is a view of its own).
// compact (tablet): the title is already in the bar above, grid and view open from ⋯, zoom with two fingers.
export default function ArrangementView({ player, item, lanes, settings, update, onVideoOutput, onMixer = toggleMixerWindow, canEdit, setlistId, notify, compact = false }) {
  const loaded = player.loaded;
  const videoOpen = useOutputOpen('video');
  const peaks = usePeaks();
  useMix();
  const scroller = useRef(null);
  // Horizontal scrollbar of the timeline, always at the bottom of the view: the native one is at
  // the end of the lanes and goes out of sight when the lanes are taller than the room (Dettaglio open).
  const hbar = useRef(null);
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
  const [cueMove, setCueMove] = useState(null); // { from, to }: one cue dragged to another square
  const [addOpen, setAddOpen] = useState(false);
  const [barsOpen, setBarsOpen] = useState(false); // "Aggiungi → Battute" dialog
  const [clipDrag, setClipDrag] = useState(null); // { stemId, index, delta } moving a segment, { stemId, index, edge, t } trimming it
  const [selection, setSelection] = useState(null); // { stemId, index: segment or null }
  const [prompterDrag, setPrompterDrag] = useState(null); // seconds the gobbo is moved by while dragging
  const [autoDrag, setAutoDrag] = useState(null); // { stemId, points } of the automation being edited (stemId CLICK_ID = the click)
  const [muteDrag, setMuteDrag] = useState(null); // { id, points } of the mute automation whose edge is dragged
  const [tempoEdit, setTempoEdit] = useState(null); // bar of the tempo change open in its editor
  const [tempoDrag, setTempoDrag] = useState(null); // { from, bar } of a tempo change being moved
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
  const waitingNet = !!usePendingSaves()[song?.id]; // saved offline, not yet sent
  const [saving, setSaving] = useState(false);
  const tool = TOOLS.some(([k]) => k === settings.arrTool) ? settings.arrTool : 'select';
  const songStems = new Map(stemsOf(song).map((s) => [s.id, s]));
  const mixSaved = !!player.mixSaved;
  const writing = useAutoWrite(); // W of the channels

  const sec = useSections({ player, setlistId, canEdit, notify, quant: settings.jumpQuant });
  const { sections } = sec;
  // ---------- Tempo changes (lane Click · Tempo) ----------
  const tempoChanges = tempoChangesOf(song);
  const barTime = (n) => sec.bars.find((b) => b.bar === n)?.t ?? null;
  const tempoMarks = tempoChanges.map((c) => ({ ...c, t: barTime(c.bar), tEnd: c.ramp ? barTime(c.bar + c.ramp) : null }));
  const tempoBpms = (tempo?.segments || []).filter((sg) => !sg.countIn).map((sg) => sg.bpm);
  const tempoRange = tempoBpms.length ? [Math.min(...tempoBpms) - 5, Math.max(...tempoBpms) + 5] : [60, 180];
  // The grid follows the audio beat by beat (click stem) or the anchors set by hand: the changes have no effect.
  const tempoIgnored = !!(gridOf(song).anchors.length || (loaded?.sync?.analysis?.mode === 'click' && !gridOf(song).bpm));
  const commitTempo = (list, label) => {
    if (!song || !canEditSong) return;
    const next = cleanTempoChanges(list);
    const value = next.length ? next : null;
    editDraft(song.id, { item: { tempoChanges: value } });
    recordStep(song.id, { label, before: { media: {}, item: { tempoChanges: song.tempoChanges ?? null } }, after: { media: {}, item: { tempoChanges: value } } });
    notify(`${label}${tempoIgnored ? ' · la griglia segue la traccia click o gli ancoraggi: il cambio non si sente finché c’è' : ' · “Salva” per tenerlo'}`);
  };
  // A new change on the bar nearest to t, at the tempo the song has there.
  const addTempoAt = (t) => {
    if (!canEditSong || !sec.bars.length) return;
    const i = nearestBarIndex(sec.bars, t);
    const b = sec.bars[Math.max(1, i)];
    if (!b) return;
    if (tempoChanges.some((c) => c.bar === b.bar)) {
      setTempoEdit(b.bar);
      return;
    }
    const bpm = Math.round(b.seg.bpm);
    commitTempo([...tempoChanges, { bar: b.bar, bpm, ramp: 0 }], `Cambio di tempo alla battuta ${b.bar}`);
    setTempoEdit(b.bar);
  };
  const tempoMarkAt = (t) => tempoMarks.find((m) => m.t != null && Math.abs(m.t - t) <= TEMPO_HIT / pps);

  // “Sincronizza” on the video track: its offset from its sound against the stems, into the draft.
  const [aligning, setAligning] = useState(false);
  const alignLoadedVideo = async () => {
    if (!song || aligning) return;
    setAligning(true);
    try {
      const res = await alignVideo(song);
      const video = { ...videoOf(song), offset: res.offset };
      editDraft(song.id, { media: { video } });
      recordStep(song.id, { label: 'Video sincronizzato', reload: true, before: { media: { video: song.video ?? null }, item: {} }, after: { media: { video }, item: {} } });
      player.reload();
      notify(`${alignText(song.title, res)} · “Salva” per tenerlo`, !res.sure);
    } catch (e) {
      notify(`Video di “${song.title}” non sincronizzato: ${e?.message || e}`, true);
    } finally {
      setAligning(false);
    }
  };

  const rows = [];
  if (loaded?.video)
    rows.push({
      kind: 'video',
      name: loaded.video.name,
      offset: loaded.video.offset,
      duration: loaded.duration,
      color: ROLE_COLORS.video,
      onOutput: onVideoOutput,
      onAlign: canEditSong && canAlignVideo(song) ? alignLoadedVideo : null,
      aligning,
    });
  loaded?.tracks.forEach(
    (t, i) =>
      // The live track of the cues is mixed from the cue track's header; the
      // "Cues" file of the mixdown is an audio track as the others.
      !(cue.exists && i === cue.audioIndex) &&
      rows.push({
        kind: 'audio',
        stem: t.stem,
        index: i,
        name: t.stem.name,
        local: t.local,
        duration: t.info?.duration,
        color: laneColor(lanes, t.stem),
        muted: mixSaved ? !!t.stem.muted : (getMix(t.stem.id).mute ?? !!t.stem.muted),
        auto: t.stem.live ? [] : autoDrag?.stemId === t.stem.id ? autoDrag.points : automationOf(songStems.get(t.stem.id)),
        muteAuto: t.stem.live ? [] : muteDrag?.id === t.stem.id ? muteDrag.points : muteAutomationOf(songStems.get(t.stem.id)),
        read: t.stem.live || automationRead(songStems.get(t.stem.id)),
        hasAuto: !t.stem.live && hasAutomation(songStems.get(t.stem.id)),
        write: !!writing[t.stem.id],
        regions: t.stem.live
          ? stemRegions(null, '')
          : clipDrag?.stemId === t.stem.id
            ? clipDrag.edge
              ? trimSegment(stemRegions(song, t.stem.id), clipDrag.index, clipDrag.edge, clipDrag.t, t.info?.duration || duration)
              : moveSegment(stemRegions(song, t.stem.id), clipDrag.index, clipDrag.delta)
            : stemRegions(song, t.stem.id),
        dragIndex: clipDrag?.stemId === t.stem.id ? clipDrag.index : -1,
        selected: selection?.stemId === t.stem.id ? (selection.index ?? -1) : null,
      }),
  );
  if (loaded && cue.exists) rows.push({ kind: 'cue' });
  // Gobbo: its changes as one track, moved together when the song changed (a longer intro…).
  const prompter = normalizePrompter(song?.prompter);
  if (loaded && prompter.cues.length) rows.push({ kind: 'prompter', data: prompter, delta: prompterDrag ?? 0, dragging: prompterDrag != null });
  if (loaded) {
    const seg = tempo?.segments?.find((s) => !s.countIn);
    rows.push({
      kind: 'click',
      enabled: settings.click.enabled,
      // Volume and mute automation of the click (R/W, the Automazione tool).
      auto: autoDrag?.stemId === CLICK_ID ? autoDrag.points : automationOf(clickAutoOf(song)),
      muteAuto: muteDrag?.id === CLICK_ID ? muteDrag.points : muteAutomationOf(clickAutoOf(song)),
      read: automationRead(clickAutoOf(song)),
      hasAuto: clickHasAutomation(song),
      write: !!writing[CLICK_ID],
      onToggle: () => update({ click: { ...settings.click, enabled: !settings.click.enabled } }),
      onAddTempo: canEditSong ? () => addTempoAt(Math.max(0, engineStatus().position)) : null,
      info: seg ? `${Math.round(seg.bpm * 100) / 100} BPM · ${seg.timeSig}${tempoChanges.length ? ` · ${tempoChanges.length === 1 ? '1 cambio' : `${tempoChanges.length} cambi`}` : ''}` : '',
    });
  }
  const height = RULER_H + rows.length * LANE_H;

  const [secDrag, setSecDrag] = useState(null); // { index, bar } of the section being moved
  const [secName, setSecName] = useState(null); // index of the section being renamed
  // As they are drawn: the one being moved already in its new place.
  const drawnSections = secDrag
    ? sections.map((s, i) => {
        const t = sec.bars[secDrag.bar]?.t ?? s.start;
        if (s.index === secDrag.index) return { ...s, start: Math.min(t, s.end) };
        return sections[i + 1]?.index === secDrag.index ? { ...s, end: Math.max(t, s.start) } : s;
      })
    : sections;
  const sectionNow = useEngineStatus((s) => sectionIndexAt(sections, Math.max(0, s.position)));
  const goSection = (s) => s && sec.go(s);
  // Before bar 1 the next section is the first one.
  const prevSection = sectionNow > 0 ? sections[sectionNow - 1] : null;
  const nextSection = sections[sectionNow + 1] || null;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const sync = () => {
      setView({ width: el.clientWidth, scroll: el.scrollLeft });
      const h = hbar.current;
      if (h && Math.abs(h.scrollLeft - el.scrollLeft) > 1) h.scrollLeft = el.scrollLeft;
    };
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
      const byG = cueDrag ? new Map(cue.shifted(cueDrag).map((c) => [c.g, c.label])) : cueMove ? new Map(cue.moved(cueMove.from, cueMove.to).map((c) => [c.g, c.label])) : cue.byG;
      const cueDraw = { bars: cue.bars, byG, muted: cue.muted, status: cue.busy || cue.status, hover: cueDrag ? null : cueMove ? cueMove.to : cueHover, nowG: nowCue };
      const moving = tempoDrag && { ...tempoMarks.find((m) => m.bar === tempoDrag.from), bar: tempoDrag.bar, t: barTime(tempoDrag.bar), tEnd: null };
      const tempoLane = { marks: tempoMarks.filter((m) => m.bar !== tempoDrag?.from), range: tempoRange, open: tempoEdit, drag: moving };
      draw(canvas.current, { width: view.width, height, scroll: view.scroll, pps, t0, tempo, rows, peaks, duration, warp, cue: cueDraw, sections: drawnSections, tempoLane, autoTool: tool === 'auto' });
    }
  });

  // The draft is dropped once the song (or the stored grid) changes.
  const storedGrid = JSON.stringify(player.loadedItem?.grid ?? null);
  useEffect(() => setDraft(null), [storedGrid, loaded?.itemId]);
  useEffect(() => {
    setSelection(null);
    setTempoEdit(null);
  }, [loaded?.itemId]);

  // Ins: a new section at the playhead, as a marker in Cubase.
  const addSectionKey = useRef();
  addSectionKey.current = sec.addAtPlayhead;
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Insert' && !e.target.closest?.('input, select, textarea')) addSectionKey.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
      notify(savedMessage(song.title, await saveDraft(setlistId, song)));
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
  // Arrow only: the hand always moves the whole segment, even grabbed at its start.
  const trimmable = (row) => row?.kind === 'audio' && !row.stem.live && canEditSong && tool === 'select';

  // New regions of one track: into the song's draft, undoable, heard at once.
  // The grid stays where it is even when the edited track is its reference.
  const commitRegions = (stem, regions, label) => {
    let all = { ...regionsOf(song), [stem.id]: regions };
    if (stem.id === loaded?.sync?.source?.id) all = keepGrid(all, stemRegions(song, stem.id), stem.id);
    const closed = closeLeadingGap(song, all, tempo?.origin);
    if (closed) {
      writeClosedGap(closed, label);
      notify(`${label}: ${gapText(closed)}`);
      return;
    }
    editDraft(song.id, { media: { regions: all } });
    recordStep(song.id, { label, before: { media: { regions: song.regions ?? null }, item: {} }, after: { media: { regions: all }, item: {} } });
    player.applyRegions({ ...song, regions: all }, { [stem.id]: regions });
    notify(label);
  };

  // The song without its empty start: into the draft, undoable; the grid moved too, so it reloads.
  const writeClosedGap = ({ media, fields }, label) => {
    const before = (o) => Object.fromEntries(Object.keys(o).map((k) => [k, song[k] ?? null]));
    editDraft(song.id, { media, item: fields });
    recordStep(song.id, { label, reload: true, before: { media: before(media), item: before(fields) }, after: { media, item: fields } });
    player.reload();
  };

  // Songs saved with an empty start: once per session and set of tracks (new tracks
  // loaded are checked again), so undo and "Scarta" stay final.
  const gapChecked = useRef(new Set());
  useEffect(() => {
    if (!song || !canEditSong || loaded?.itemId !== song.id || !tempo) return;
    const key = `${song.id}:${(loaded.tracks || [])
      .map((x) => x.stem.id)
      .sort()
      .join(',')}`;
    if (gapChecked.current.has(key)) return;
    gapChecked.current.add(key);
    const closed = closeLeadingGap(song, regionsOf(song), tempo?.origin);
    if (closed) {
      writeClosedGap(closed, 'Corretto l’inizio del brano');
      notify(`“${song.title}”: ${gapText(closed)}. “Salva” per tenerlo, Ctrl+Z per annullare`);
      return;
    }
    // Audio before bar -1 (bar 1 found where the reference stem enters): bar 1 goes back to the audio.
    const lead = leadToAudio(song, tempo);
    if (!lead) return;
    writeClosedGap(lead, 'Battuta 1 all’inizio dell’audio');
    notify(`“${song.title}”: la battuta 1 è tornata all’inizio dell’audio (${lead.bars === 1 ? '1 battuta' : `${lead.bars} battute`} prima). “Salva” per tenerlo, Ctrl+Z per annullare`);
  });

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

  // Volume automation of a track: into the song's draft (mix of the live performance), undoable, heard at once.
  const commitAuto = (stem, points, label) => {
    if (!song || !canEditSong) return;
    const clean = points.map((pt) => ({ t: Math.round(Math.max(0, pt.t) * 1e4) / 1e4, db: Math.round(pt.db * 10) / 10 })).sort((a, b) => a.t - b.t);
    writeMix(song, { stems: stemsOf(song).map((x) => (x.id === stem.id ? { ...x, auto: clean.length ? clean : null } : x)) }, label);
    notify(`${label} · “Salva” per tenerla`);
  };
  // Mute automation of a track: the same way.
  const commitMuteAuto = (stem, points, label) => {
    if (!song || !canEditSong) return;
    const clean = muteAutomationOf({ muteAuto: points.map((pt) => ({ t: Math.round(Math.max(0, pt.t) * 1e4) / 1e4, on: !!pt.on })) });
    writeMix(song, { stems: stemsOf(song).map((x) => (x.id === stem.id ? { ...x, muteAuto: clean.length ? clean : null } : x)) }, label);
    notify(`${label} · “Salva” per tenerla`);
  };
  // Volume automation of the click (lane Click · Tempo): the same way, in item.clickAuto.
  const commitClickAuto = (points, label) => {
    if (!song || !canEditSong) return;
    const clean = points.map((pt) => ({ t: Math.round(Math.max(0, pt.t) * 1e4) / 1e4, db: Math.round(pt.db * 10) / 10 })).sort((a, b) => a.t - b.t);
    setClickVolume(song, clean, label);
    notify(`${label} · “Salva” per tenerla`);
  };
  const commitClickMute = (points, label) => {
    if (!song || !canEditSong) return;
    setClickMute(song, points.map((pt) => ({ t: Math.round(Math.max(0, pt.t) * 1e4) / 1e4, on: !!pt.on })), label);
    notify(`${label} · “Salva” per tenerla`);
  };
  // The automation of a row that the Automazione tool edits: a track (not live) or the click.
  const autoLane = (row) => {
    if (row?.kind === 'audio' && !row.stem.live) {
      const { stem } = row;
      return {
        id: stem.id,
        of: `di “${stem.name}”`,
        vol: (pts, label) => commitAuto(stem, pts, label),
        mute: (pts, label) => commitMuteAuto(stem, pts, label),
        muteLabel: (on, at) => `${on ? 'Mute' : 'Fine del mute'} in “${stem.name}” a ${fmtTime(at)}`,
        edgeGone: `Tolto un bordo del mute di “${stem.name}”`,
        edgeMoved: (at) => `Bordo del mute di “${stem.name}” spostato a ${fmtTime(at)}`,
      };
    }
    if (row?.kind === 'click') {
      return {
        id: CLICK_ID,
        of: 'del click',
        vol: commitClickAuto,
        mute: commitClickMute,
        muteLabel: (on, at) => `${on ? 'Click fermato' : 'Click ripartito'} a ${fmtTime(at)}`,
        edgeGone: 'Tolto un bordo del tratto senza click',
        edgeMoved: (at) => `Bordo del tratto senza click spostato a ${fmtTime(at)}`,
      };
    }
    return null;
  };
  // What the Automazione tool would grab at (px, py) of a row: 'point', 'line', 'edge' (flag of a mute edge) or null.
  const autoGrab = (row, px, py) => {
    const ri = rows.indexOf(row);
    if (ri < 0) return null;
    const y0 = RULER_H + ri * LANE_H;
    if (py <= y0 + AUTO_TOP + 2 && (row.muteAuto || []).some((m) => Math.abs((m.t - t0) * pps - px) <= AUTO_HIT)) return 'edge';
    const pts = row.auto || [];
    if (pts.some((pt) => Math.abs((pt.t - t0) * pps - px) <= AUTO_HIT && Math.abs(autoY(pt.db, y0) - py) <= AUTO_HIT)) return 'point';
    if (pts.length && Math.abs(autoY(automationDb(pts, (px / pps) + t0), y0) - py) <= AUTO_HIT) return 'line';
    return null;
  };

  // Automazione tool on a track or on the click lane (Cubase style):
  // - click: a new point of the volume (on the beats with Griglia, Shift = the other way), dragged at once;
  // - a point dragged in time and level, Alt+click (or double click) removes it;
  // - the line between two points (or the level before the first / after the last) dragged up or down;
  // - Alt+drag: the curve drawn by hand where the pointer goes;
  // - Ctrl+click: mute (or stop the click) from there, on an edge of the mute: that edge goes;
  // - the red flag of an edge of the mute dragged in time.
  const editAutomation = (e, row, t, rect) => {
    const lane = autoLane(row);
    if (!lane) return false;
    if (row.kind === 'audio') setSelection({ stemId: row.stem.id, index: null });
    if (!canEditSong) {
      notify('Solo chi può modificare il brano può disegnare l’automazione', true);
      return true;
    }
    const y0 = RULER_H + rows.indexOf(row) * LANE_H;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const tAt = (ev) => (ev.clientX - rect.left) / pps + t0;
    const snapT = (tt, ev) => Math.max(0, snap !== ev.shiftKey && tempo ? snapToBeat(tempo, tt) : tt);
    const el = e.currentTarget;
    const drag = (onMove, onUp) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const yy0 = e.clientY;
      let moved = false;
      const move = (ev) => {
        if (!moved && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - yy0) < 3) return;
        moved = true;
        onMove(ev);
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        onUp(moved);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    const mutes = row.muteAuto || [];
    const edge = mutes.findIndex((m) => Math.abs((m.t - t0) * pps - px) <= AUTO_HIT);
    if (e.ctrlKey || e.metaKey) {
      if (edge >= 0) {
        lane.mute(mutes.filter((_, i) => i !== edge), lane.edgeGone);
        return true;
      }
      const at = snapT(t, e);
      const on = !automationMutedAt(mutes, at);
      lane.mute([...mutes, { t: at, on }], lane.muteLabel(on, at));
      return true;
    }
    if (edge >= 0 && !e.altKey && py <= y0 + AUTO_TOP + 2) {
      const lo = (mutes[edge - 1]?.t ?? -0.001) + 0.001;
      const hi = (mutes[edge + 1]?.t ?? Infinity) - 0.001;
      let list = mutes;
      drag(
        (ev) => {
          const nt = Math.min(hi, Math.max(lo, snapT(tAt(ev), ev)));
          list = mutes.map((m, i) => (i === edge ? { ...m, t: nt } : m));
          setMuteDrag({ id: lane.id, points: list });
        },
        (moved) => {
          setMuteDrag(null);
          if (moved) lane.mute(list, lane.edgeMoved(list[edge].t));
        },
      );
      return true;
    }
    const pts = row.auto || [];
    const hit = pts.findIndex((pt) => Math.abs((pt.t - t0) * pps - px) <= AUTO_HIT && Math.abs(autoY(pt.db, y0) - py) <= AUTO_HIT);
    if (e.altKey) {
      // Drawn by hand: one point every 4 px of the stroke (going back redraws them).
      const cols = new Map();
      const add = (ev) => {
        const cx = ev.clientX - rect.left;
        cols.set(Math.round(cx / 4), { t: Math.max(0, cx / pps + t0), db: autoDbAt(ev.clientY - rect.top, y0) });
      };
      const stroke = () => [...cols.values()].sort((a, b) => a.t - b.t);
      add(e);
      drag(
        (ev) => {
          add(ev);
          setAutoDrag({ stemId: lane.id, points: mergeStroke(pts, stroke()) });
        },
        (moved) => {
          setAutoDrag(null);
          if (!moved) {
            if (hit >= 0) lane.vol(pts.filter((_, i) => i !== hit), `Tolto un punto dell’automazione ${lane.of}`);
            return;
          }
          lane.vol(mergeStroke(pts, thinAutomation(stroke())), `Automazione ${lane.of} disegnata a mano`);
        },
      );
      return true;
    }
    if (hit < 0 && pts.length && Math.abs(autoY(automationDb(pts, t), y0) - py) <= AUTO_HIT) {
      // The line: its two points move up or down together (by the same height on screen).
      const after = pts.findIndex((pt) => pt.t > t);
      const idx = after < 0 ? [pts.length - 1] : after === 0 ? [0] : [after - 1, after];
      let list = pts;
      drag(
        (ev) => {
          const dy = ev.clientY - e.clientY;
          list = pts.map((pt, i) => (idx.includes(i) ? { ...pt, db: autoDbAt(autoY(pt.db, y0) + dy, y0) } : pt));
          setAutoDrag({ stemId: lane.id, points: list });
        },
        (moved) => {
          setAutoDrag(null);
          if (moved) {
            lane.vol(list, `Linea dell’automazione ${lane.of} spostata: ${idx.map((i) => dbLabel(list[i].db)).join(' → ')}`);
            return;
          }
          // A click on the line: a point on it.
          const at = snapT(t, e);
          const pt = { t: at, db: automationDb(pts, at) };
          lane.vol([...pts, pt], `Nuovo punto nell’automazione ${lane.of}: ${dbLabel(pt.db)}`);
        },
      );
      return true;
    }
    const added = hit < 0;
    let list = pts;
    let index = hit;
    if (added) {
      const pt = { t: snapT(t, e), db: autoDbAt(py, y0) };
      list = [...pts, pt].sort((a, b) => a.t - b.t);
      index = list.indexOf(pt);
    }
    setAutoDrag({ stemId: lane.id, points: list });
    drag(
      (ev) => {
        const lo = list[index - 1]?.t ?? 0;
        const hi = list[index + 1]?.t ?? Infinity;
        const nt = Math.min(hi, Math.max(lo, snapT(tAt(ev), ev)));
        list = list.map((pt, i) => (i === index ? { t: nt, db: autoDbAt(ev.clientY - rect.top, y0) } : pt));
        setAutoDrag({ stemId: lane.id, points: list });
      },
      (moved) => {
        setAutoDrag(null);
        if (!added && !moved) return;
        lane.vol(list, `${added ? 'Nuovo punto' : 'Punto spostato'} nell’automazione ${lane.of}: ${dbLabel(list[index].db)}`);
      },
    );
    return true;
  };

  const deleteSelected = () => {
    if (tool === 'auto' && canEditSong && selectedStem) {
      if (hasAutomation(selectedStem) && confirm(`Togliere tutta l’automazione (volume e mute) di “${selectedStem.name}”?`)) {
        writeMix(song, { stems: stemsOf(song).map((x) => (x.id === selectedStem.id ? { ...x, auto: null, muteAuto: null } : x)) }, `Automazione di “${selectedStem.name}” tolta`);
        notify(`Automazione di “${selectedStem.name}” tolta · “Salva” per tenerla`);
      }
      return;
    }
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

  // Gobbo moved as a whole: how it was made stays, only where it falls changes. Into the draft, undoable.
  const movePrompter = (delta) => {
    if (!canEditSong || !song?.prompter || Math.abs(delta) < 1e-3) return;
    const first = normalizePrompter(song.prompter).cues[0]?.t ?? 0;
    const d = Math.max(-first, delta);
    if (Math.abs(d) < 1e-3) return;
    const next = shiftPrompter(song.prompter, d);
    const label = `Gobbo spostato ${d > 0 ? 'avanti' : 'indietro'} di ${Math.abs(d).toFixed(2).replace('.', ',')} s`;
    editDraft(song.id, { item: { prompter: next } });
    recordStep(song.id, { label, before: { media: {}, item: { prompter: song.prompter } }, after: { media: {}, item: { prompter: next } } });
    notify(`${label}. “Salva” per tenerlo`);
  };
  // A beat (Shift: a bar) of the grid where the gobbo starts.
  const prompterStep = (dir, bar) => {
    const first = normalizePrompter(song?.prompter).cues[0]?.t ?? 0;
    const seg = tempo?.segments?.find((s) => !s.countIn);
    const beat = seg?.beat || 0.5;
    movePrompter(Math.max(-first, dir * (bar ? beat * (seg?.beats || 4) : beat)));
  };
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
    const at = cueCellAt(cue.bars, (e.clientX - rect.left) / pps + t0);
    // The coloured strip on top of the clip (with the CUE badge) grabs the whole track, as a clip.
    const y = (e.clientY - rect.top - RULER_H) % LANE_H;
    return at && { ...at, strip: y < 18 };
  };

  // Lane of the sections: click goes there, Ctrl+click adds one, the start of a section drags.
  const onLane = (e) => {
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    return y >= MARK_Y && y < RULER_H;
  };
  const laneSection = (t) => sections.findLast((s) => t >= s.start - MARK_EDGE / pps && t < s.end);
  const laneEdge = (s, t) => !!s && sec.editable && Math.abs(t - s.start) <= MARK_EDGE / pps;
  const laneDown = (e, t) => {
    if (e.ctrlKey) {
      sec.add(nearestBarIndex(sec.bars, t));
      return;
    }
    const s = laneSection(t);
    if (!s) return;
    if (!laneEdge(s, t)) {
      sec.go(s);
      return;
    }
    e.preventDefault();
    const el = e.currentTarget;
    const box = el.getBoundingClientRect();
    el.setPointerCapture(e.pointerId);
    const from = e.clientX;
    let bar = null;
    const move = (ev) => {
      if (bar == null && Math.abs(ev.clientX - from) < 4) return;
      const prev = sections[sections.indexOf(s) - 1];
      const lo = prev ? prev.barIndex + 1 : 0;
      const hi = s.barIndex + Math.max(1, s.bars) - 1;
      bar = Math.max(lo, Math.min(hi, nearestBarIndex(sec.bars, (ev.clientX - box.left) / pps + t0)));
      setSecDrag({ index: s.index, bar });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setSecDrag(null);
      if (bar == null) sec.go(s);
      else sec.move(s.index, bar);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onMouseMove = (e) => {
    if (onLane(e)) {
      const pt = (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps + t0;
      const s = laneSection(pt);
      e.currentTarget.style.cursor = laneEdge(s, pt) ? 'ew-resize' : s ? 'pointer' : sec.editable ? 'copy' : '';
      if (cueHover != null) setCueHover(null);
      return;
    }
    const hit = cue.canEdit ? cueHit(e) : null;
    const box = e.currentTarget.getBoundingClientRect();
    const row = !hit && !warpOn ? rows[Math.floor((e.clientY - box.top - RULER_H) / LANE_H)] : null;
    const pt = (e.clientX - box.left) / pps + t0;
    const onSegment = row?.kind === 'audio' && !row.stem.live && segmentAt(row, pt) >= 0;
    const onEdge = trimmable(row) && !!edgeAt(row, pt);
    const toolCursor = TOOLS.find(([k]) => k === tool)[4];
    const cueCursor = tool === 'move' || (tool !== 'erase' && hit && cue.byG.has(hit.cell.g)) ? 'grab' : tool === 'erase' ? 'not-allowed' : 'pointer';
    const grab = tool === 'auto' && canEditSong && autoLane(row) ? autoGrab(row, e.clientX - box.left, e.clientY - box.top) : null;
    const special =
      tool === 'auto' && canEditSong && autoLane(row)
        ? e.altKey
          ? 'crosshair'
          : grab === 'edge'
            ? 'ew-resize'
            : grab === 'point'
              ? 'move'
              : grab === 'line'
                ? 'ns-resize'
                : 'crosshair'
        : row?.kind === 'click' && tempoMarkAt(pt)
          ? canEditSong
            ? 'ew-resize'
            : 'pointer'
          : null;
    e.currentTarget.style.cursor = special || (hit ? cueCursor : onEdge ? 'ew-resize' : onSegment && (canEditSong || tool === 'select') ? toolCursor : row?.kind === 'prompter' && canEditSong ? 'grab' : '');
    const g = tool === 'move' ? null : (hit?.cell.g ?? null);
    if (g !== cueHover) setCueHover(g);
  };

  const lastTap = useRef({ at: 0, x: 0 });
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    // The second finger of a pinch zooms (above): it must not cut, move or locate.
    if (e.pointerType === 'touch' && !e.isPrimary) return;
    // Touch: two taps in the same place are a double click (rename a section, pin a grid line).
    if (e.pointerType === 'touch') {
      const now = performance.now();
      const double = now - lastTap.current.at < DOUBLE_TAP && Math.abs(e.clientX - lastTap.current.x) < TAP_SLOP * 3;
      lastTap.current = { at: double ? 0 : now, x: e.clientX };
      if (double) {
        onDoubleClick(e);
        return;
      }
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const t = (e.clientX - rect.left) / pps + t0;
    if (onLane(e)) {
      laneDown(e, t);
      return;
    }
    const hit = cue.canEdit ? cueHit(e) : null;
    if (hit) {
      const open = () => setPicking({ ...hit, rect: { left: e.clientX - 20, bottom: e.clientY + 8 } });
      // Eraser: removes the cue of the square.
      if (tool === 'erase') {
        if (cue.byG.has(hit.cell.g)) cue.setCue(hit.cell.g, null);
        return;
      }
      // Arrow: a touch opens the menu; a cue dragged goes to the square where it is dropped.
      // The strip on top moves the whole track with every tool, like the hand.
      if (tool !== 'move' && !hit.strip) {
        if (!cue.byG.has(hit.cell.g)) {
          open();
          return;
        }
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const x0 = e.clientX;
        let to = null;
        const move = (ev) => {
          if (to == null && Math.abs(ev.clientX - x0) < 4) return;
          const at = cueCellAt(cue.bars, (ev.clientX - rect.left) / pps + t0);
          if (!at) return;
          to = at.cell.g;
          setCueMove({ from: hit.cell.g, to });
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          setCueMove(null);
          if (to == null) open();
          else cue.moveCue(hit.cell.g, to);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        return;
      }
      // Hand: the whole cue track moves square by square; it never opens the menu.
      if (!cue.cues.length) return;
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
        cue.shift(delta);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      return;
    }
    // Segments of the tracks, by tool (Cubase style): arrow selects, hand
    // moves (on the beats with "Griglia", Shift = the other way), scissors
    // cut where clicked, X mutes / unmutes, eraser deletes.
    const row = rows[Math.floor((e.clientY - rect.top - RULER_H) / LANE_H)];
    // Automazione: the volume and mute of a track or of the click (editAutomation);
    // the tempo changes of the lane Click · Tempo stay with the other tools.
    if (tool === 'auto' && !warpOn && editAutomation(e, row, t, rect)) return;
    // Lane Click · Tempo: a change is dragged to another bar, a touch on it opens its editor.
    if (row?.kind === 'click' && !warpOn) {
      const m = tempoMarkAt(t);
      if (m) {
        e.preventDefault();
        if (!canEditSong) {
          setTempoEdit(m.bar);
          return;
        }
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const x0 = e.clientX;
        let bar = null;
        const move = (ev) => {
          if (bar == null && Math.abs(ev.clientX - x0) < 4) return;
          const b = sec.bars[Math.max(1, nearestBarIndex(sec.bars, (ev.clientX - rect.left) / pps + t0))]?.bar;
          if (b == null || (b !== m.bar && tempoChanges.some((c) => c.bar === b))) return;
          bar = b;
          setTempoDrag({ from: m.bar, bar });
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          setTempoDrag(null);
          if (bar == null || bar === m.bar) {
            setTempoEdit(m.bar);
            return;
          }
          commitTempo(
            tempoChanges.map((c) => (c.bar === m.bar ? { ...c, bar } : c)),
            `Cambio di tempo spostato alla battuta ${bar}`,
          );
          setTempoEdit(bar);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        return;
      }
      setTempoEdit(null);
    }
    // Gobbo: a drag moves all its changes together (on the beats with "Griglia", Shift = the other way); a touch locates.
    if (row?.kind === 'prompter' && !warpOn) {
      if (!canEditSong) {
        if (e.pointerType === 'touch') locateOnTap(e, t);
        else player.locate(t);
        return;
      }
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const first = row.data.cues[0].t;
      let delta = null;
      const move = (ev) => {
        if (delta == null && Math.abs(ev.clientX - x0) < 4) return;
        const raw = (ev.clientX - x0) / pps;
        const d = snap !== ev.shiftKey && tempo ? snapToBeat(tempo, first + raw) - first : raw;
        // The first change never before the start of the song.
        delta = Math.max(-first, d);
        setPrompterDrag(delta);
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        setPrompterDrag(null);
        if (delta == null) player.locate(t);
        else movePrompter(delta);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      return;
    }
    // Start or end of a segment (arrow): drag to trim it, the audio stays where it is.
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
      if (e.pointerType === 'touch') locateOnTap(e, t);
      else player.locate(t);
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

  // A finger moves the playhead when it lifts without having scrolled the timeline (a scroll cancels the pointer).
  const locateOnTap = (e, t) => {
    const el = e.currentTarget;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const done = () => {
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', done);
    };
    const up = (ev) => {
      done();
      if (Math.abs(ev.clientX - x0) < TAP_SLOP && Math.abs(ev.clientY - y0) < TAP_SLOP && !longPressed()) player.locate(t);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', done);
  };

  // Double click on a grid line: pin it where it is.
  const onDoubleClick = (e) => {
    {
      const rect = e.currentTarget.getBoundingClientRect();
      const ri = Math.floor((e.clientY - rect.top - RULER_H) / LANE_H);
      const row = rows[ri];
      const t = (e.clientX - rect.left) / pps + t0;
      const lane = tool === 'auto' && canEditSong && !warpOn ? autoLane(row) : null;
      if (lane) {
        const y0 = RULER_H + ri * LANE_H;
        const hit = row.auto.findIndex((pt) => Math.abs((pt.t - t0) * pps - (e.clientX - rect.left)) <= AUTO_HIT && Math.abs(autoY(pt.db, y0) - (e.clientY - rect.top)) <= AUTO_HIT);
        if (hit >= 0) lane.vol(row.auto.filter((_, i) => i !== hit), `Tolto un punto dell’automazione ${lane.of}`);
        return;
      }
      if (row?.kind === 'click' && !warpOn) {
        if (canEditSong && !tempoMarkAt(t)) addTempoAt(t);
        return;
      }
    }
    if (onLane(e)) {
      const s = sec.editable ? laneSection((e.clientX - e.currentTarget.getBoundingClientRect().left) / pps + t0) : null;
      if (s) setSecName(s.index);
      return;
    }
    if (!warpOn) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const line = lineAt((e.clientX - rect.left) / pps + t0);
    if (!line || line.anchor) return;
    const bpm = grid.bpm ?? tempo?.segments?.find((s) => !s.countIn)?.bpm ?? null;
    commitGrid({ ...grid, bpm, anchors: moveAnchor(grid.anchors, line.g, line.t, tempo?.origin) });
  };

  // ---------- Context menus: right click, long press on touch screens ----------

  // Cut one track at t (scissors, Ctrl+E, menu).
  const cutStem = (stem, t) => {
    const res = cutAt(stemRegions(song, stem.id), t, fileSeconds(stem.id));
    if (!res) {
      notify(`Il punto scelto non è sopra una clip di “${stem.name}”`, true);
      return;
    }
    commitRegions(stem, res.regions, `Tagliata “${stem.name}” a ${fmtTime(Math.max(0, t))}`);
    setSelection({ stemId: stem.id, index: res.index });
  };
  const removeAuto = (stem) => {
    if (!confirm(`Togliere tutta l’automazione (volume e mute) di “${stem.name}”?`)) return;
    writeMix(song, { stems: stemsOf(song).map((x) => (x.id === stem.id ? { ...x, auto: null, muteAuto: null } : x)) }, `Automazione di “${stem.name}” tolta`);
    notify(`Automazione di “${stem.name}” tolta · “Salva” per tenerla`);
  };
  const trackItems = (r) => {
    if (r.kind === 'audio') {
      const { stem } = r;
      const live = stem.live;
      return [
        { label: 'Muto', checked: r.muted, onSelect: () => player.setTrack(stem, { mute: !r.muted }) },
        { label: 'Solo', checked: !!player.solos[stem.id], onSelect: () => player.setTrack(stem, { solo: !player.solos[stem.id] }) },
        !live && canEditSong && { label: 'Taglia alla testina', icon: 'scissors', keys: 'Ctrl+E', onSelect: () => cutStem(stem, engineStatus().position) },
        !live && canEditSong && r.hasAuto && { label: 'Leggi l’automazione', checked: r.read !== false, keys: 'R', onSelect: () => toggleRead(song, stem) },
        !live && canEditSong && r.hasAuto && { label: 'Togli l’automazione', icon: 'trash', danger: true, onSelect: () => removeAuto(stem) },
      ];
    }
    if (r.kind === 'click') {
      return [
        { label: 'Click acceso', checked: r.enabled, keys: 'C', onSelect: r.onToggle },
        r.onAddTempo && { label: 'Cambio di tempo alla testina', icon: 'metronome', onSelect: r.onAddTempo },
        canEditSong && r.hasAuto && { label: 'Leggi l’automazione', checked: r.read !== false, onSelect: () => toggleClickRead(song) },
        canEditSong &&
          r.hasAuto && {
            label: 'Togli l’automazione del click',
            icon: 'trash',
            danger: true,
            onSelect: () => {
              if (!confirm('Togliere tutta l’automazione del click (volume e tratti senza click)?')) return;
              setClickAutomation(song, { muteAuto: [], auto: [] }, 'Automazione del click tolta');
              notify('Automazione del click tolta · “Salva” per tenerla');
            },
          },
      ];
    }
    if (r.kind === 'video') {
      return [
        r.onAlign && { label: 'Sincronizza il video con le tracce', icon: 'wand', disabled: r.aligning, onSelect: r.onAlign },
        r.onOutput && { label: videoOpen ? 'Chiudi l’uscita video' : 'Apri l’uscita video', icon: 'monitor', keys: 'F4', onSelect: r.onOutput },
      ];
    }
    if (r.kind === 'cue') {
      return [
        { label: 'Cue mute', checked: cue.muted, onSelect: cue.toggleMute },
        cue.canEdit && { label: cue.resolution === 8 ? 'Quadratini in quarti' : 'Quadratini in ottavi', icon: 'grid', onSelect: () => cue.setResolution(cue.resolution === 8 ? 4 : 8) },
        cue.canEdit && cue.cues.length > 0 && { label: 'Tutte le cue avanti di una battuta', icon: 'chevron-right', onSelect: () => cue.shift(cue.barBeats * cue.cellStep) },
        cue.canEdit && cue.cues.length > 0 && { label: 'Tutte le cue indietro di una battuta', icon: 'chevron-left', onSelect: () => cue.shift(-cue.barBeats * cue.cellStep) },
      ];
    }
    if (r.kind === 'prompter' && canEditSong) {
      return [
        { label: 'Gobbo avanti di un movimento', icon: 'chevron-right', onSelect: () => prompterStep(1, false) },
        { label: 'Gobbo indietro di un movimento', icon: 'chevron-left', onSelect: () => prompterStep(-1, false) },
        { label: 'Gobbo avanti di una battuta', icon: 'chevron-right', onSelect: () => prompterStep(1, true) },
        { label: 'Gobbo indietro di una battuta', icon: 'chevron-left', onSelect: () => prompterStep(-1, true) },
      ];
    }
    return [];
  };
  const rowTitle = (r) => (r.kind === 'audio' ? r.name : r.kind === 'click' ? 'Click · Tempo' : r.kind === 'video' ? r.name : r.kind === 'cue' ? 'Cues' : r.kind === 'prompter' ? 'Gobbo' : undefined);
  // On the name of a track.
  const headerMenu = (e, r) => {
    if (r.kind === 'audio' && !r.stem.live) setSelection((s) => (s?.stemId === r.stem.id ? s : { stemId: r.stem.id, index: null }));
    openContextMenu(e, trackItems(r), { title: rowTitle(r) });
  };
  // On the timeline: what is under the pointer first, then the song.
  const timelineMenu = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = (e.clientX - rect.left) / pps + t0;
    const snapT = Math.max(0, snap && tempo ? snapToBeat(tempo, t) : t);
    const at = { left: e.clientX - 20, bottom: e.clientY + 8 };
    let title;
    let head = [];
    if (onLane(e)) {
      const s = laneSection(t);
      title = s?.label || 'Sezioni';
      head = [
        s && { label: 'Vai alla sezione', icon: 'skip-forward', onSelect: () => sec.go(s) },
        s && sec.editable && { label: 'Rinomina…', icon: 'edit', onSelect: () => setSecName(s.index) },
        s && sec.editable && { label: 'Elimina la sezione', icon: 'trash', danger: true, hint: 'La sezione prima prende le sue battute', onSelect: () => sec.remove(s.index) },
      ];
    } else if (!warpOn) {
      const row = rows[Math.floor((e.clientY - rect.top - RULER_H) / LANE_H)];
      title = row && rowTitle(row);
      if (row?.kind === 'audio') {
        const { stem } = row;
        const index = stem.live ? -1 : segmentAt(row, t);
        const seg = canEditSong && index >= 0;
        if (index >= 0) setSelection({ stemId: stem.id, index });
        else if (!stem.live) setSelection({ stemId: stem.id, index: null });
        const muted = index >= 0 && !!row.regions[index]?.muted;
        head = [
          seg && { label: 'Taglia qui', icon: 'scissors', onSelect: () => cutStem(stem, snapT) },
          seg && {
            label: muted ? 'Riattiva il segmento' : 'Muta il segmento',
            keys: 'X',
            onSelect: () => commitRegions(stem, toggleSegmentMute(stemRegions(song, stem.id), index), `${muted ? 'Riattivato' : 'Mutato'} un segmento di “${stem.name}”`),
          },
          seg && {
            label: 'Elimina il segmento',
            icon: 'trash',
            danger: true,
            keys: 'Canc',
            onSelect: () => {
              commitRegions(stem, removeSegment(stemRegions(song, stem.id), index), `Eliminato un segmento di “${stem.name}”`);
              setSelection({ stemId: stem.id, index: null });
            },
          },
          '-',
          ...trackItems(row),
        ];
      } else if (row?.kind === 'cue') {
        const hit = cue.canEdit ? cueHit(e) : null;
        const has = hit && cue.byG.has(hit.cell.g);
        head = [
          hit && { label: has ? 'Cambia la cue…' : 'Metti una cue…', icon: 'mic', onSelect: () => setPicking({ ...hit, rect: at }) },
          has && { label: 'Togli la cue', icon: 'trash', danger: true, onSelect: () => cue.setCue(hit.cell.g, null) },
          hit && { label: 'Conteggio 1-2-3-4 nella battuta', icon: 'metronome', onSelect: () => cue.countBar(hit.cell.bar) },
          '-',
          ...trackItems(row),
        ];
      } else if (row?.kind === 'click') {
        const m = tempoMarkAt(t);
        head = [
          m && { label: `Cambio della battuta ${m.bar}…`, icon: 'edit', onSelect: () => setTempoEdit(m.bar) },
          m &&
            canEditSong && {
              label: 'Togli il cambio di tempo',
              icon: 'trash',
              danger: true,
              onSelect: () => {
                if (!confirm(`Togliere il cambio della battuta ${m.bar}?`)) return;
                commitTempo(
                  tempoChanges.filter((c) => c.bar !== m.bar),
                  `Tolto il cambio della battuta ${m.bar}`,
                );
                setTempoEdit(null);
              },
            },
          !m && canEditSong && { label: 'Cambio di tempo qui', icon: 'metronome', onSelect: () => addTempoAt(t) },
          '-',
          ...trackItems(row),
        ];
      } else if (row) head = trackItems(row);
    }
    openContextMenu(
      e,
      [
        ...head,
        '-',
        { label: 'Sposta qui la testina', icon: 'pointer', onSelect: () => player.locate(Math.max(0, t)) },
        sec.editable && { label: 'Aggiungi una sezione qui', icon: 'marker-add', keys: 'Ins', onSelect: () => sec.add(nearestBarIndex(sec.bars, t)) },
        '-',
        canEditSong && { label: history.past.length ? `Annulla: ${history.past.at(-1).label}` : 'Annulla', icon: 'undo', keys: 'Ctrl+Z', disabled: !history.past.length, onSelect: () => goHistory(-1) },
        canEditSong && { label: history.future.length ? `Ripeti: ${history.future.at(-1).label}` : 'Ripeti', icon: 'undo', keys: 'Ctrl+Maiusc+Z', disabled: !history.future.length, onSelect: () => goHistory(1) },
        dirty && { label: 'Salva il brano', icon: 'check', keys: 'Ctrl+S', disabled: saving, onSelect: saveSong },
        dirty && { label: 'Scarta le modifiche', icon: 'x', danger: true, disabled: saving, onSelect: discardSong },
      ],
      { title },
    );
  };

  // Playhead and page-follow (Ableton style) at display rate.
  // Display rate only while playing (animateWhilePlaying).
  useEffect(() => {
    const tick = () => {
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
    return animateWhilePlaying(tick).stop;
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

  // Two fingers on the timeline: zoom around the point between them (touch screens).
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    let pinch = null;
    let raf = 0;
    const span = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY) || 1;
    const start = (e) => {
      if (e.touches.length !== 2) return;
      const r = el.getBoundingClientRect();
      const ax = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
      pinch = { d: span(e.touches), pps: ppsRef.current, ax, t: (el.scrollLeft + ax) / ppsRef.current };
    };
    const move = (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const next = Math.max(MIN_PPS, Math.min(MAX_PPS, (pinch.pps * span(e.touches)) / pinch.d));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        update({ pxPerSec: next });
        requestAnimationFrame(() => {
          el.scrollLeft = pinch ? pinch.t * next - pinch.ax : el.scrollLeft;
        });
      });
    };
    const end = (e) => {
      if (e.touches.length < 2) pinch = null;
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [update, !!loaded]);

  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = scroller.current.getBoundingClientRect();
    zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - rect.left);
  };

  // Back to the start of the song (Home), with the view at the start too.
  const toStart = () => {
    player.locate(0);
    if (scroller.current) scroller.current.scrollLeft = 0;
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
      <Toolbar id="arrangement" title="Arrangement" className="arr-toolbar" overflow={compact}>
        {!compact && (
          <ToolGroup id="song" label="Brano" grow>
            <strong className="ellipsis">{player.loadedItem?.title}</strong>
            <span className="small muted">
              {loaded.tracks.length} tracce{loaded.video ? ' · video' : ''}
            </span>
          </ToolGroup>
        )}
        <ToolGroup id="start" label="Inizio" pin>
          <button className="btn btn-sm btn-icon" onClick={toStart} title="Torna all’inizio del brano (Home)" aria-label="Torna all’inizio del brano" data-midi="arrangement.start" data-midi-name="Torna all’inizio">
            <Icon name="to-start" size={14} />
          </button>
        </ToolGroup>
        <ToolGroup id="edit" label="Modifica" pin>
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
              <button key={k} className={tool === k ? 'is-on' : ''} onClick={() => update({ arrTool: k })} disabled={k !== 'select' && !canEditSong} title={`${label} (${key})`}>
                <Icon name={icon} size={14} />
              </button>
            ))}
          </span>
        </ToolGroup>
        <ToolGroup id="grid" label="Griglia">
          <SyncControl player={player} />
          <button
            className={`btn btn-sm ${snap ? 'is-on' : ''}`}
            onClick={() => update({ snapGrid: !snap })}
            title={snap ? 'Griglia attiva: le tracce trascinate si agganciano ai movimenti (Shift = libero)' : 'Griglia spenta: le tracce si spostano liberamente (Shift = aggancia)'}
          >
            <Icon name="grid" size={13} /> Griglia
          </button>
          <button
            className={`btn btn-sm ${warpOn ? 'is-on' : ''}`}
            onClick={() => setEditing((v) => !v)}
            disabled={!canEdit}
            title={canEdit ? 'Allinea a mano griglia e click all’audio: ancoraggi, tempo, intervallo di analisi (W)' : 'Solo chi può modificare la scaletta'}
          >
            <Icon name="edit" size={13} /> Griglia a mano
          </button>
        </ToolGroup>
        {sections.length > 0 && (
          <ToolGroup id="sections" label="Sezioni" pin>
            <span className="arr-sections" role="group" aria-label="Sezioni">
              <button
                className="btn btn-sm btn-icon"
                onClick={() => goSection(prevSection)}
                disabled={!prevSection}
                title={prevSection ? `Vai a ${prevSection.label}` : 'Sei alla prima sezione'}
                aria-label="Sezione precedente"
              >
                <Icon name="skip-back" size={13} />
              </button>
              <span className="arr-section-now ellipsis" style={{ color: sections[sectionNow]?.color }}>
                {sections[sectionNow]?.label || 'Sezioni'}
              </span>
              <button
                className="btn btn-sm btn-icon"
                onClick={() => goSection(nextSection)}
                disabled={!nextSection}
                title={nextSection ? `Vai a ${nextSection.label}` : 'Sei all’ultima sezione'}
                aria-label="Sezione successiva"
              >
                <Icon name="skip-forward" size={13} />
              </button>
            </span>
          </ToolGroup>
        )}
        {dirty && (
          <ToolGroup id="save" label="Salvataggio" locked pin>
            <span className="arr-save">
              <span className="small arr-unsaved">Non salvato</span>
              <button className="btn btn-sm btn-ghost" onClick={discardSong} disabled={saving} title="Torna all’ultimo salvataggio">
                Scarta
              </button>
              <button className="btn btn-sm btn-primary" onClick={saveSong} disabled={saving} title="Salva le modifiche del brano per tutta la band (Ctrl+S)">
                <Icon name="check" size={13} /> {saving ? 'Salvataggio…' : 'Salva'}
              </button>
            </span>
          </ToolGroup>
        )}
        {!dirty && waitingNet && (
          <ToolGroup id="save" label="Salvataggio" locked pin>
            <span className="arr-save">
              <span className="small arr-unsaved" title="Salvato su questo dispositivo: le modifiche arrivano alla band appena torna la connessione">
                <Icon name="globe" size={12} /> In attesa di rete
              </span>
            </span>
          </ToolGroup>
        )}
        <ToolGroup id="view" label="Vista">
          <button className={`btn btn-sm ${settings.followPlayhead ? 'is-on' : ''}`} onClick={() => update({ followPlayhead: !settings.followPlayhead })} title="Segui la testina">
            <Icon name="follow" size={14} /> Segui
          </button>
          <button className="btn btn-sm btn-icon" onClick={() => zoom(1 / 1.5)} title="Riduci (Ctrl + rotella)">
            <Icon name="zoom-out" size={14} />
          </button>
          <button className="btn btn-sm btn-icon" onClick={() => zoom(1.5)} title="Ingrandisci (Ctrl + rotella)">
            <Icon name="zoom-in" size={14} />
          </button>
          <button className="btn btn-sm" onClick={fit} title="Adatta il brano alla finestra">
            <Icon name="maximize" size={14} /> Adatta
          </button>
          {onMixer && (
            <button className="btn btn-sm" onClick={onMixer} title="Mixer delle tracce in una finestra separata (F3). Anche nel Dettaglio, tab Mixer">
              <Icon name="sliders" size={14} /> Mixer
            </button>
          )}
        </ToolGroup>
        {onVideoOutput && (
          <ToolGroup id="output" label="Uscite">
            <button className={`btn btn-sm ${videoOpen ? 'is-on' : ''}`} onClick={onVideoOutput} aria-pressed={videoOpen} title={videoOpen ? 'Chiudi l’uscita video (F4)' : 'Apri l’uscita video (F4)'}>
              <Icon name="monitor" size={14} /> Uscita video
            </button>
          </ToolGroup>
        )}
      </Toolbar>
      {warpOn && <GridBar grid={grid} tempo={tempo} onChange={commitGrid} />}
      <div className="arr-body">
        <div className="arr-timeline" ref={scroller} onWheel={onWheel}>
          <div
            className={`arr-content is-tool-${tool} ${warpOn ? 'is-warp' : ''}`}
            style={{ width: contentW, height }}
            onPointerDown={onPointerDown}
            onDoubleClick={onDoubleClick}
            onContextMenu={timelineMenu}
            onMouseMove={onMouseMove}
            onMouseLeave={() => setCueHover(null)}
          >
            <canvas className="arr-canvas" ref={canvas} />
            {sections
              .filter((s) => s.index === secName)
              .map((s) => (
                <input
                  key={s.index}
                  className="arr-sec-name"
                  style={{ left: (s.start - t0) * pps + 5, top: MARK_Y + 2 }}
                  defaultValue={s.name}
                  placeholder={s.label}
                  aria-label="Nome della sezione"
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    const label = e.target.value.trim();
                    if (label !== s.name) sec.rename(s.index, label);
                    setSecName(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') e.target.blur();
                    if (e.key === 'Escape') {
                      e.target.value = s.name;
                      e.target.blur();
                    }
                  }}
                />
              ))}
            {tempoEdit != null &&
              (() => {
                const m = tempoMarks.find((x) => x.bar === tempoEdit);
                const ci = rows.findIndex((r) => r.kind === 'click');
                if (!m || m.t == null || ci < 0) return null;
                const set = (patch, label) => commitTempo(tempoChanges.map((c) => (c.bar === m.bar ? { ...c, ...patch } : c)), label);
                return (
                  <TempoEditor
                    key={m.bar}
                    mark={m}
                    left={(m.t - t0) * pps}
                    top={RULER_H + ci * LANE_H + 2}
                    editable={canEditSong}
                    ignored={tempoIgnored}
                    onBpm={(bpm) => set({ bpm }, bpm ? `Battuta ${m.bar}: ${bpm} BPM` : `Battuta ${m.bar}: il tempo resta quello di prima`)}
                    onSig={(timeSig) => set({ timeSig }, timeSig ? `Battuta ${m.bar}: metro ${timeSig}` : `Battuta ${m.bar}: il metro resta quello di prima`)}
                    onRamp={(ramp) => set({ ramp }, ramp ? `Battuta ${m.bar}: tempo graduale in ${ramp} battute` : `Battuta ${m.bar}: tempo subito`)}
                    onRemove={() => {
                      if (!confirm(`Togliere il cambio della battuta ${m.bar}?`)) return;
                      commitTempo(
                        tempoChanges.filter((c) => c.bar !== m.bar),
                        `Tolto il cambio della battuta ${m.bar}`,
                      );
                      setTempoEdit(null);
                    }}
                    onClose={() => setTempoEdit(null)}
                  />
                );
              })()}
            <div className="arr-playhead" ref={playhead} style={{ height }} />
          </div>
        </div>
        <div className="arr-headers">
          <div className="arr-ruler-head">
            <span>Tracce</span>
            <span className="arr-lane-head">
              Sezioni
              <button
                className="toggle"
                onClick={sec.addAtPlayhead}
                disabled={!sec.editable}
                title="Aggiungi una sezione alla battuta della testina (Ins). Ctrl+clic sulla corsia: nel punto scelto"
                aria-label="Aggiungi una sezione alla testina"
              >
                <Icon name="marker-add" size={13} />
              </button>
            </span>
          </div>
          {rows.map((r, i) =>
            r.kind === 'cue' ? (
              <CueHeader key="cue" cue={cue} solos={player.solos} onTrack={player.setTrack} loadedTracks={loaded.tracks} onMenu={(e) => headerMenu(e, r)} />
            ) : r.kind === 'prompter' ? (
              <div key="prompter" className="t-header" style={{ '--lane-color': '#f8fafc' }} onContextMenu={(e) => headerMenu(e, r)}>
                <span className="t-color" />
                <span className="t-name" title="I cambi slide del gobbo: trascinali per riallinearli al brano">
                  Gobbo
                </span>
                {canEditSong && (
                  <span className="t-btns">
                    <button className="toggle" onClick={(e) => prompterStep(-1, e.shiftKey)} title="Sposta tutto il gobbo indietro di un movimento (Maiusc: di una battuta)">
                      ‹
                    </button>
                    <button className="toggle" onClick={(e) => prompterStep(1, e.shiftKey)} title="Sposta tutto il gobbo avanti di un movimento (Maiusc: di una battuta)">
                      ›
                    </button>
                  </span>
                )}
                <div className="t-row small muted">
                  {r.data.cues.length} cambi · da {fmtTime(Math.max(0, r.data.cues[0].t + r.delta))}
                </div>
              </div>
            ) : (
              <TrackHeader
                key={r.stem?.id || r.kind + i}
                row={r}
                index={r.index}
                solos={player.solos}
                onTrack={player.setTrack}
                saved={mixSaved}
                onMenu={(e) => headerMenu(e, r)}
                auto={song ? { song, canEdit: canEditSong } : null}
                selected={r.kind === 'audio' && selection?.stemId === r.stem.id}
                onSelect={r.kind === 'audio' && !r.stem.live ? () => setSelection((s) => (s?.stemId === r.stem.id ? s : { stemId: r.stem.id, index: null })) : undefined}
              />
            ),
          )}
        </div>
      </div>
      <div className="arr-hscroll">
        <div
          className="arr-hscroll-bar"
          ref={hbar}
          style={{ width: view.width }}
          onScroll={(e) => {
            const el = scroller.current;
            const x = e.currentTarget.scrollLeft;
            if (el && Math.abs(el.scrollLeft - x) > 1) el.scrollLeft = x;
          }}
        >
          <div style={{ width: contentW, height: 1 }} />
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
