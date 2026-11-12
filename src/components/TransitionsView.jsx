// Transizioni page of the Palco (edit mode): the setlist as songs on a timeline, two
// lanes taking turns, so that a transition shows where the next song starts over the
// end of the one before. The song after can be dragged (overlap or pause), the fades
// pulled by their handles, its start trimmed to a section; the type and the values
// in the panel below. "Prova" plays the end of the song and the transition, in the
// engine, as it will be live. Every change is written at once for the whole band.
//
// Picture over sound: with videos in the setlist every clip shows, over its waveform, what the
// video output shows (frames of its video, else the picture of the setlist). A video item has its picture and its sound each
// with a fade in, a fade out and an end (media.js audioFades): the picture can fade out
// while the sound goes on, or the other way round; a monitor shows the output.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { audioApart, audioFades, fadeLevel, fadeStop, isVideoItem, VIDEO_FADE_MAX, videoFades, videoOf } from '../shared/media.js';
import { onThumbs, thumbAt, thumbRatio } from '../lib/videoThumbs';
import VideoOutput from './VideoOutput';
import { keyLabel } from '../shared/music.js';
import { animateWhilePlaying, engine, engineStatus, livePosition, subscribeStatus, useEngineStatus } from '../lib/engine';
import { itemCacheState, ensureItems, requestPeaks, useMediaCache, usePeaks } from '../lib/mediaCache';
import { clipAt, itemBeats, layoutSetlist, songLength, songLevels, songRegions, songTracks } from '../lib/setlistTimeline';
import { isLinked, lastSectionStart, LINK_FADE_MAX, LINK_PAUSE_MAX, LINK_RESET, playedKey, setItemFields, songChange, TRANSITIONS, transitionLabel } from '../lib/songChange';
import Icon from './Icon';

const RULER_H = 24;
const HEAD_H = 24; // title of the clip
const SEC_H = 20; // row of the sections
const LANE_GAP = 10;
const PAD_H = 14;
const VID_H = 44; // the picture strip of a clip, over its waveform
const PIC_COLOR = '#f0abfc'; // line of the picture level
const THUMB_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const MONITOR_KEY = 'livetools.transitions.monitor';
const PAD_X = 28; // px before the start of the setlist
const MIN_PPS = 0.05;
const MAX_PPS = 240;
const FOLLOW_PAUSE = 3000;
const COLORS = ['#38bdf8', '#a78bfa', '#34d399', '#f472b6', '#fb923c', '#facc15'];
const VIDEO_COLOR = '#e04fd0';
const PREROLLS = [4, 8, 15];

const ICON = { cue: 'skip-forward', stay: 'stop', autolink: 'play', overlap: 'layers', crossfade: 'merge' };
const fmt = (s) => `${(Math.round(s * 10) / 10).toFixed(1).replace('.', ',')} s`;
const clockText = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
// m:ss,d
const clockTenths = (sec) => {
  const t = Math.round(Math.max(0, sec) * 10) / 10;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0').replace('.', ',')}`;
};
const colorOf = (c) => (isVideoItem(c.item) ? VIDEO_COLOR : COLORS[c.index % COLORS.length]);
const xfade = (x) => Math.sin(Math.max(0, Math.min(1, x)) * (Math.PI / 2));
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * The video of every clip, for its picture strip: { src (null: not on this computer), offset,
 * rate, file (s of the video), pic and sound (fades of a video item, null for the video of
 * a song), a / b (timeline seconds where its picture is on the output) } or null.
 * The picture of a video item goes on over the next song (the tail of the video output);
 * the video of a song leaves the output when the next song takes over.
 */
function clipVideos(clips, cache, loaded, peaks) {
  return clips.map((c, i) => {
    const video = videoOf(c.item);
    if (!video) return null;
    const own = isVideoItem(c.item);
    const offset = Number(video.offset) || 0;
    const local = loaded?.itemId === c.item.id && loaded.video ? loaded.video.local : cache[video.path]?.ready ? cache[video.path].local : null;
    const src = loaded?.itemId === c.item.id && loaded.video ? loaded.video.src : local ? convertFileSrc(local) : null;
    const file = (local && peaks[local]?.duration) || Math.max(1, c.duration - offset);
    const pic = own ? videoFades(c.item) : null;
    const sound = own ? audioFades(c.item) : null;
    const a = c.x0 + offset / c.rate;
    let b = c.x0 + (offset + (pic ? fadeStop(pic, file) : file)) / c.rate;
    const next = clips[i + 1];
    if (!own && next && c.link?.at != null) b = Math.min(b, c.link.at);
    return { src, offset, rate: c.rate, file, pic, sound, a, b: Math.max(a, b) };
  });
}

// Level (0..1) of picture or sound of a video at `x` seconds of the timeline.
function ownLevel(c, m, fades, x) {
  if (!m || !fades) return 1;
  const v = (x - c.x0) * c.rate - m.offset;
  return v < 0 ? 0 : fadeLevel(v, m.file, fades);
}

// Gain of a clip at `x` seconds of the timeline: its fade in, its fade out under the next
// one, the fades of the sound of a video item.
function gainAt(c, prev, x, m) {
  if (x < c.from || x > c.until) return 0;
  let g = m?.sound ? ownLevel(c, m, m.sound, x) : 1;
  const fin = prev?.link?.timing?.fadeIn || 0;
  if (fin > 0) g = Math.min(g, xfade((x - c.from) / fin));
  const fout = c.link?.timing?.fadeOut || 0;
  if (fout > 0 && c.link.at != null && x > c.link.at) g = Math.min(g, xfade(1 - (x - c.link.at) / fout));
  return g;
}

// The sound set apart from the picture, from the values it has now (the ones of the picture).
const apartFields = (item) => {
  const p = videoFades(item);
  return { audioApart: true, audioFadeIn: p.in, audioFadeOut: p.out, audioEnd: p.end };
};
const SOUND_TOGETHER = { audioApart: null, audioFadeIn: null, audioFadeOut: null, audioEnd: null };

/**
 * Fields of a fade or of the end of picture (pic*) or sound (snd*) of a video item, from a
 * handle at `t` seconds of the song (or a step: `value` given directly). The sound follows
 * the picture until it is moved by itself: then it is set apart (audioApart).
 */
function ownFadePatch(item, m, kind, t, snap) {
  if (!m) return null;
  const pic = kind.startsWith('pic');
  const fades = pic ? m.pic : m.sound;
  const stop = fadeStop(fades, m.file);
  const q = snap ? 0.5 : 0.1;
  const r = (n) => round2(Math.round(n / q) * q);
  const v = t - m.offset; // seconds of the video
  let key;
  let val;
  if (kind.endsWith('In')) {
    key = 'FadeIn';
    val = Math.max(0, Math.min(VIDEO_FADE_MAX, stop, r(v)));
  } else if (kind.endsWith('Out')) {
    key = 'FadeOut';
    val = Math.max(0, Math.min(VIDEO_FADE_MAX, stop, r(stop - v)));
  } else {
    key = 'End';
    const e = Math.max(1, Math.min(m.file, r(v)));
    val = e >= m.file - 0.05 ? null : e;
  }
  if (pic) return { [`video${key}`]: val };
  return { ...(audioApart(item) ? {} : apartFields(item)), [`audio${key}`]: val };
}

// Offset of the next song changed by a drag or a button: past the end it becomes a
// pause (AutoLink), over the end an overlap; the crossfade stays one while it overlaps.
function offsetPatch(mode, offset) {
  const off = round2(offset);
  if (off > 0.04) return { transition: 'autolink', linkOffset: Math.min(off, LINK_PAUSE_MAX), linkFadeOut: null };
  if (mode === 'autolink') return off < -0.04 ? { transition: 'overlap', linkOffset: off } : { transition: 'autolink', linkOffset: 0 };
  return { transition: mode, linkOffset: Math.min(0, off) };
}

const barsOf = (beats) => beats.filter((b) => b.inBar === 0);
function nearestBar(beats, t) {
  let best = null;
  barsOf(beats).forEach((b) => {
    if (best == null || Math.abs(b.t - t) < Math.abs(best - t)) best = b.t;
  });
  return best;
}
function barSeconds(c) {
  const bars = barsOf(c.beats);
  return bars.length > 1 ? (bars.at(-1).t - bars.at(-2).t) / c.rate : 2;
}

function waitFor(test, ms) {
  return new Promise((resolve) => {
    if (test()) return resolve(true);
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, ms);
    const off = subscribeStatus(() => {
      if (!test()) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
    return undefined;
  });
}

// The picture strip of a clip, over its waveform (they move together): frames of its
// video dimmed along the level of the picture, with its line; where the song has no
// video, what the output shows instead (picture of the setlist, or black).
function drawClipVideo(ctx, { c, m, top, w, X, pps, still, heardA, heardB, xa: clipA, xb: clipB }) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(clipA, top, clipB - clipA, VID_H);
  ctx.clip();
  ctx.font = '600 10px system-ui, sans-serif';
  // Without video (or before it starts): the screen as it is without one.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(heardA, top, heardB - heardA, VID_H);
  const free = m ? X(m.a) - heardA : heardB - heardA;
  if (free > 130) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.32)';
    ctx.fillText(still ? 'Immagine della scaletta' : 'Schermo nero', Math.max(heardA, 0) + 8, top + VID_H / 2 + 4);
  }
  if (m) {
    const xa = X(m.a);
    const xb = X(m.b);
    if (xb >= 0 && xa <= w && xb - xa >= 1) {
      ctx.fillStyle = 'rgba(224, 79, 208, 0.18)';
      ctx.fillRect(xa, top, xb - xa, VID_H);
      // Frames side by side from the start of the picture; each the frame of its middle,
      // rounded to a step of video seconds so that the same ones come back while scrolling.
      if (m.src) {
        const tw = (VID_H - 2) * thumbRatio(m.src);
        const per = (tw / pps) * m.rate; // video seconds per frame drawn
        const q = [...THUMB_STEPS].reverse().find((v) => v <= per) || THUMB_STEPS[0];
        const n0 = Math.max(0, Math.floor(-xa / tw));
        const n1 = Math.ceil((Math.min(w, xb) - xa) / tw);
        for (let n = n0; n < n1; n += 1) {
          const vt = Math.round(((((n + 0.5) * tw) / pps) * m.rate) / q) * q;
          const img = thumbAt(m.src, Math.min(vt, Math.max(0, m.file - 0.1)));
          if (img) ctx.drawImage(img, xa + n * tw, top + 1, tw, VID_H - 2);
        }
      } else if (xb - xa > 140) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.fillText('Video non scaricato su questo computer', Math.max(xa, 0) + 8, top + VID_H / 2 + 4);
      }
      // Dimmed where the picture fades, and its level as a line.
      if (m.pic) {
        const x0 = Math.max(0, Math.floor(xa));
        const x1 = Math.min(w, Math.ceil(xb));
        for (let x = x0; x <= x1; x += 2) {
          const g = ownLevel(c, m, m.pic, (x - X(0)) / pps);
          if (g < 0.999) {
            ctx.fillStyle = `rgba(0, 0, 0, ${(1 - g) * 0.85})`;
            ctx.fillRect(x, top, 2, VID_H);
          }
        }
        ctx.beginPath();
        for (let x = x0; x <= x1; x += 2) {
          const y = top + 3 + (1 - ownLevel(c, m, m.pic, (x - X(0)) / pps)) * (VID_H - 6);
          if (x === x0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = PIC_COLOR;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
  }
  ctx.restore();
  // Line between picture and sound.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.fillRect(clipA, top + VID_H, clipB - clipA, 1);
}

function draw(canvas, { clips, media, still, width: w, height: h, left, pps, laneH, vidLane, padLane, peaks, cache, loaded, selected, snapLines }) {
  if (!w || !h) return;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const X = (t) => PAD_X + t * pps - left;
  const t0 = (left - PAD_X) / pps;
  const t1 = t0 + w / pps;
  const laneTop = (lane) => RULER_H + lane * (laneH + LANE_GAP);
  const bottom = RULER_H + laneH * 2 + LANE_GAP; // end of the two lanes

  // Ruler: a label every 60 px at least.
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * pps >= 60) || 600;
  ctx.font = '600 10px system-ui, sans-serif';
  for (let t = Math.max(0, Math.floor(t0 / step) * step); t <= t1; t += step) {
    const x = Math.round(X(t));
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(x, RULER_H - 7, 1, 7);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fillText(clockText(t), x + 3, 13);
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(0, RULER_H - 1, w, 1);

  // The transitions: the overlap across both lanes, the pause hatched.
  clips.forEach((c, i) => {
    const next = clips[i + 1];
    if (!next || c.link?.at == null) return;
    const end = c.x0 + c.length;
    const a = Math.min(next.from, end);
    const b = Math.max(next.from, end);
    if (X(b) < 0 || X(a) > w) return;
    const on = i === selected;
    if (next.from < end) {
      ctx.fillStyle = on ? 'rgba(34, 211, 238, 0.14)' : 'rgba(34, 211, 238, 0.07)';
      ctx.fillRect(X(a), RULER_H, X(b) - X(a), bottom - RULER_H);
    } else if (next.from > end + 0.01) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(X(a), RULER_H, X(b) - X(a), bottom - RULER_H);
      ctx.clip();
      ctx.strokeStyle = on ? 'rgba(251, 191, 36, 0.3)' : 'rgba(255, 255, 255, 0.08)';
      for (let x = X(a) - bottom; x < X(b); x += 8) {
        ctx.beginPath();
        ctx.moveTo(x, bottom);
        ctx.lineTo(x + bottom, RULER_H);
        ctx.stroke();
      }
      ctx.restore();
    }
  });

  clips.forEach((c, i) => {
    const xa = X(c.x0);
    const xb = X(c.x0 + c.length);
    if (xb < 0 || xa > w) return;
    const prev = clips[i - 1];
    const color = colorOf(c);
    const top = laneTop(c.lane);
    const vidTop = top + HEAD_H + SEC_H;
    const waveTop = vidTop + (vidLane ? VID_H : 0);
    const waveH = laneH - (waveTop - top);
    const heardA = X(c.from);
    const heardB = X(c.until);
    const on = i === selected || i === selected + 1;
    // Body: the part heard in the colour of the song, the rest (trimmed head, end cut by a fade) dimmed.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
    ctx.fillRect(xa, top, xb - xa, laneH);
    ctx.globalAlpha = on ? 0.2 : 0.13;
    ctx.fillStyle = color;
    ctx.fillRect(heardA, top, heardB - heardA, laneH);
    ctx.globalAlpha = 1;
    // Sections: coloured bands under the waveform.
    c.sections.forEach((s) => {
      const sa = Math.max(X(c.x0 + s.start / c.rate), heardA);
      const sb = Math.min(X(c.x0 + s.end / c.rate), heardB);
      if (sb <= sa) return;
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = s.color;
      ctx.fillRect(sa, top + HEAD_H, sb - sa, laneH - HEAD_H);
      ctx.globalAlpha = 0.9;
      ctx.fillRect(sa, top + HEAD_H, 2, laneH - HEAD_H);
      ctx.globalAlpha = 1;
    });
    // The picture over the sound, in the same clip.
    if (vidLane) drawClipVideo(ctx, { c, m: media[i], top: vidTop, w, X, pps, still, heardA, heardB, xa, xb });
    // Bars of the song, when there is room for them.
    const bars = barsOf(c.beats);
    if (bars.length > 1 && ((bars[1].t - bars[0].t) / c.rate) * pps >= 7) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
      bars.forEach((b) => {
        const x = X(c.x0 + b.t / c.rate);
        if (x >= Math.max(0, xa) && x <= Math.min(w, xb)) ctx.fillRect(Math.round(x), waveTop, 1, waveH);
      });
    }
    // Waveform: the stems summed, shrinking along the fades.
    const px0 = Math.max(0, Math.floor(xa));
    const px1 = Math.min(w, Math.ceil(xb));
    if (px1 > px0) {
      const tracks = songTracks(c.item, cache, loaded);
      const levels = songLevels(tracks, peaks, songRegions(c.item), ((px0 + left - PAD_X) / pps - c.x0) * c.rate, c.rate / pps, px1 - px0);
      const mid = waveTop + waveH / 2;
      const amp = waveH / 2 - 2;
      for (let k = 0; k < levels.length; k += 1) {
        const v = levels[k] / 255;
        if (v <= 0.002) continue;
        const x = px0 + k;
        const t = (x + left - PAD_X) / pps;
        const g = gainAt(c, prev, t, media[i]);
        if (g <= 0) {
          ctx.fillStyle = 'rgba(244, 244, 245, 0.16)';
          const a = v * amp;
          ctx.fillRect(x, mid - a, 1, a * 2);
        } else {
          ctx.fillStyle = 'rgba(244, 244, 245, 0.75)';
          const a = v * amp * g;
          if (a > 0.3) ctx.fillRect(x, mid - a, 1, a * 2);
        }
      }
    }
    // Fade curves, as in a DAW: the line of the volume over the waveform.
    const curve = (from, len, up) => {
      ctx.beginPath();
      for (let k = 0; k <= 32; k += 1) {
        const u = k / 32;
        const g = up ? xfade(u) : xfade(1 - u);
        const x = X(from + u * len);
        const y = waveTop + (1 - g) * waveH;
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
    };
    const fin = prev?.link?.timing?.fadeIn || 0;
    if (fin > 0) curve(c.from, fin, true);
    const fout = c.link?.timing?.fadeOut || 0;
    if (fout > 0 && c.link.at != null) curve(c.link.at, fout, false);
    // The sound of a video item: its own fades and end.
    const m = media[i];
    if (m?.sound && (m.sound.in > 0 || m.sound.out > 0 || m.sound.end)) {
      ctx.beginPath();
      const s0 = Math.max(0, Math.floor(heardA));
      // Up to where it is heard (a fade out of the transition may end it before).
      const s1 = Math.min(w, Math.ceil(X(Math.min(c.until, c.x0 + (m.offset + fadeStop(m.sound, m.file)) / c.rate))));
      for (let x = s0; x <= s1; x += 2) {
        const y = waveTop + (1 - ownLevel(c, m, m.sound, (x + left - PAD_X) / pps)) * waveH;
        if (x === s0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    // Outline of the part heard.
    ctx.strokeStyle = on ? color : 'rgba(255, 255, 255, 0.14)';
    ctx.strokeRect(Math.round(heardA) + 0.5, top + 0.5, Math.max(0, heardB - heardA - 1), laneH - 1);
  });

  // While dragging: the bars the song after lands on.
  if (snapLines?.length) {
    ctx.fillStyle = 'rgba(251, 191, 36, 0.35)';
    snapLines.forEach((t) => {
      const x = X(t);
      if (x >= 0 && x <= w) ctx.fillRect(Math.round(x), RULER_H, 1, bottom - RULER_H);
    });
  }

  // Pad of the video items: from before the end of the video into the song after.
  if (padLane) {
    const y = bottom + 3;
    clips.forEach((c, i) => {
      if (!c.pad) return;
      const next = clips[i + 1];
      const end = next ? (c.pad.hold != null ? next.from + c.pad.hold + (c.pad.fadeOut || 0) : next.until) : c.x0 + c.length;
      const a = X(c.pad.at);
      const b = X(Math.max(c.pad.at, end));
      ctx.fillStyle = 'rgba(167, 139, 250, 0.55)';
      ctx.fillRect(a, y, b - a, PAD_H - 6);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '700 9px system-ui, sans-serif';
      if (b - a > 30) ctx.fillText('PAD', a + 4, y + 7);
    });
  }
}

export default function TransitionsView({ items, numbers, player, beats: loadedBeats, settings, setlistId, still = false, canEdit, notify, onClose }) {
  const peaks = usePeaks();
  const cache = useMediaCache();
  const playing = useEngineStatus((s) => s.playing);
  const songId = useEngineStatus((s) => s.songId ?? null);
  const nextQueued = useEngineStatus((s) => s.next?.songId ?? null);
  const loaded = player.loaded;
  const [patch, setPatch] = useState(null); // { id, fields } of a drag in progress
  const [selected, setSelected] = useState(null);
  const [pps, setPps] = useState(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [snap, setSnap] = useState(true);
  const [preroll, setPreroll] = useState(8);
  const [status, setStatus] = useState(null);
  const [snapLines, setSnapLines] = useState(null);
  const [viewLeft, setViewLeft] = useState(0); // scroll, for the titles that stay in sight
  const box = useRef(null);
  const scroller = useRef(null);
  const canvas = useRef(null);
  const head = useRef(null);
  const left = useRef(0);
  const userAt = useRef(0);
  const anchorX = useRef(null);

  // Length, bars and last section of every song: the loaded one from the engine.
  const infoMap = useMemo(() => {
    const map = new Map();
    items.forEach((item) => {
      if (loaded?.itemId === item.id) {
        map.set(item.id, { duration: loaded.duration, beats: loadedBeats || [], lastStart: lastSectionStart(loaded.tempo) });
        return;
      }
      const tracks = songTracks(item, cache, null);
      const duration = songLength(item, tracks, peaks, songRegions(item));
      map.set(item.id, { duration, beats: itemBeats(item, duration), lastStart: null });
    });
    return map;
  }, [items, cache, peaks, loaded, loadedBeats]);
  const layout = useMemo(
    () => layoutSetlist(items, settings, (item) => infoMap.get(item.id) || { duration: 180, beats: [], lastStart: null }, patch ? { [patch.id]: patch.fields } : {}),
    [items, settings, infoMap, patch],
  );
  const { clips, total } = layout;
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const hasPad = clips.some((c) => c.pad);
  const media = useMemo(() => clipVideos(clips, cache, loaded, peaks), [clips, cache, loaded, peaks]);
  const mediaRef = useRef(media);
  mediaRef.current = media;
  // Picture strips in the clips when the setlist has videos.
  const vidLane = media.some(Boolean);
  // With videos every clip has its picture strip over the waveform: a little taller.
  const laneH = Math.max(70 + (vidLane ? VID_H : 0), Math.min(230 + (vidLane ? VID_H : 0), (size.h - RULER_H - LANE_GAP - (hasPad ? PAD_H : 0)) / 2));
  const vidTopOf = (lane) => laneTop(lane) + HEAD_H + SEC_H;
  const waveTopOf = (lane) => vidTopOf(lane) + (vidLane ? VID_H : 0);
  // Monitor of the video output, beside the panel (remembered on this computer).
  const [monitor, setMonitor] = useState(() => {
    try {
      const v = localStorage.getItem(MONITOR_KEY);
      return v == null ? null : v === '1';
    } catch {
      return null;
    }
  });
  const monitorOn = monitor ?? (vidLane || still);
  const toggleMonitor = () => {
    setMonitor(!monitorOn);
    try {
      localStorage.setItem(MONITOR_KEY, monitorOn ? '0' : '1');
    } catch {
      // Only a convenience.
    }
  };
  const width = PAD_X * 2 + total * (pps || 1) + size.w * 0.4;

  // First transition shown: the one after the song in the player.
  useEffect(() => {
    if (selected != null || clips.length < 2) return;
    const i = clips.findIndex((c) => c.item.id === loaded?.itemId);
    setSelected(Math.max(0, Math.min(clips.length - 2, i < 0 ? 0 : i)));
  }, [clips, selected, loaded?.itemId]);

  useLayoutEffect(() => {
    const el = box.current;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  // First zoom: about 40 seconds in the window.
  useEffect(() => {
    if (pps == null && size.w) setPps(Math.max(MIN_PPS, Math.min(MAX_PPS, size.w / 40)));
  }, [size.w, pps]);

  const scrollTo = useCallback((x, smooth) => {
    const el = scroller.current;
    if (!el) return;
    if (smooth) el.scrollTo({ left: x, behavior: 'smooth' });
    else el.scrollLeft = x;
    left.current = el.scrollLeft;
  }, []);
  const center = useCallback(
    (t, smooth = true) => {
      if (!pps) return;
      scrollTo(PAD_X + t * pps - size.w / 2, smooth);
    },
    [pps, size.w, scrollTo],
  );
  // The transition chosen comes to the middle of the window.
  const shown = useRef(null);
  useEffect(() => {
    const c = clips[selected];
    if (!c || c.link?.at == null || !pps || !size.w) return;
    if (shown.current === selected) return;
    const first = shown.current == null;
    shown.current = selected;
    userAt.current = performance.now();
    center(c.link.at, !first);
  }, [selected, clips, pps, size.w, center]);

  // Zoom around a point of the window (the pointer, or the middle).
  const prevPps = useRef(pps);
  useLayoutEffect(() => {
    const prev = prevPps.current;
    prevPps.current = pps;
    if (!prev || !pps || prev === pps) return;
    const x = anchorX.current ?? size.w / 2;
    anchorX.current = null;
    const t = (left.current + x - PAD_X) / prev;
    scrollTo(PAD_X + t * pps - x);
  }, [pps, size.w, scrollTo]);
  const zoomBy = useCallback((f, x) => {
    anchorX.current = x ?? null;
    setPps((p) => Math.max(MIN_PPS, Math.min(MAX_PPS, (p || 1) * f)));
  }, []);
  const fitAll = () => {
    if (!size.w || !total) return;
    setPps(Math.max(MIN_PPS, Math.min(MAX_PPS, (size.w - PAD_X * 2) / total)));
    requestAnimationFrame(() => scrollTo(0));
  };

  // Ctrl+wheel zooms, the wheel scrolls along the setlist; two fingers pinch.
  const ppsNow = useRef(pps);
  ppsNow.current = pps;
  useEffect(() => {
    const el = scroller.current;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        userAt.current = performance.now();
        zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - el.getBoundingClientRect().left);
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    let pinch = null;
    const span = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY) || 1;
    const mid = (ts) => (ts[0].clientX + ts[1].clientX) / 2 - el.getBoundingClientRect().left;
    const start = (e) => {
      if (e.touches.length === 2) pinch = { d: span(e.touches), pps: ppsNow.current };
    };
    const move = (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      userAt.current = performance.now();
      anchorX.current = mid(e.touches);
      setPps(Math.max(MIN_PPS, Math.min(MAX_PPS, (pinch.pps * span(e.touches)) / pinch.d)));
    };
    const end = (e) => {
      if (e.touches.length < 2) pinch = null;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [zoomBy]);

  // Drawn only when something changes or scrolls.
  const paint = useRef(() => {});
  paint.current = () =>
    canvas.current &&
    pps &&
    draw(canvas.current, { clips, media, still, width: size.w, height: size.h, left: left.current, pps, laneH, vidLane, padLane: hasPad, peaks, cache, loaded, selected, snapLines });
  useEffect(() => {
    paint.current();
  });
  // Frames of the videos as they are taken.
  useEffect(() => onThumbs(() => paint.current()), []);
  const raf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const onScroll = () => {
    const x = scroller.current.scrollLeft;
    if (Math.abs(x - left.current) > 1) userAt.current = performance.now();
    left.current = x;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      setViewLeft(left.current);
      paint.current();
      wantPeaks.current();
    });
  };

  // Waveforms of the songs in sight (and the ones next to them), as they come into view.
  const wantPeaks = useRef(() => {});
  wantPeaks.current = () => {
    if (!pps || !size.w) return;
    const t0 = (left.current - PAD_X) / pps - 120;
    const t1 = t0 + size.w / pps + 240;
    clips.forEach((c) => {
      if (c.x0 + c.length < t0 || c.x0 > t1) return;
      requestPeaks(songTracks(c.item, cache, loaded).map((t) => t.local));
    });
  };
  useEffect(() => {
    wantPeaks.current();
  }, [clips, cache, loaded, pps, size.w]);

  // The playhead, on the song the engine is playing; it stays in sight while playing.
  // Display rate only while playing (animateWhilePlaying), else redrawn on status and zoom.
  const headAnim = useRef(null);
  useEffect(() => {
    const tick = () => {
      const st = engineStatus();
      const list = clipsRef.current;
      const c = list.find((k) => k.item.id === (st.songId || player.loaded?.itemId));
      const el = head.current;
      if (!el || !c || !ppsNow.current) {
        if (el) el.style.display = 'none';
        return;
      }
      const x = PAD_X + (c.x0 + Math.max(0, livePosition()) / c.rate) * ppsNow.current;
      el.style.display = '';
      el.style.transform = `translateX(${x}px)`;
      const sc = scroller.current;
      if (st.playing && sc && performance.now() - userAt.current > FOLLOW_PAUSE) {
        const rel = x - sc.scrollLeft;
        if (rel < 0 || rel > sc.clientWidth * 0.8) scrollTo(x - sc.clientWidth * 0.25);
      }
    };
    const anim = animateWhilePlaying(tick);
    headAnim.current = anim;
    return () => {
      headAnim.current = null;
      anim.stop();
    };
  }, [player.loaded?.itemId, scrollTo]);
  useEffect(() => headAnim.current?.kick(), [pps, clips]);

  const write = (id, fields) => setItemFields(setlistId, id, fields).catch((e) => notify(`Non salvato: ${e?.message || e}`, true));

  // ---------- Listening ----------
  // To a point of a song: loaded if needed; while playing a jump without gaps.
  const seek = async (c, t) => {
    // Before the start of the song after: past it the engine would hand over at once.
    const limit = c.link?.timing && c.link.at != null ? Math.max(0, (c.link.at - c.x0) * c.rate - 0.3) : c.duration;
    const to = Math.max(0, Math.min(limit, t));
    const st = engineStatus();
    try {
      if (player.loaded?.itemId === c.item.id) {
        if (st.playing && st.position >= 0) engine.scheduleJump({ at: st.position + 0.2, to, repeat: false });
        else engine.locate(to);
        return;
      }
      setStatus(`Carico “${c.item.title}”…`);
      await player.load(c.item);
      await engine.locate(to);
      if (st.playing) await engine.play(false);
    } catch (e) {
      notify(`Non riesco a spostarmi: ${e?.message || e}`, true);
    } finally {
      setStatus(null);
    }
  };

  // The end of a song and the transition into the next, as it will go live.
  const tryIt = async (i) => {
    const a = clips[i];
    const b = clips[i + 1];
    if (!a || !b) return;
    try {
      if (engineStatus().playing) await engine.stop();
      if (player.loaded?.itemId !== a.item.id) {
        setStatus(`Carico “${a.item.title}”…`);
        await player.load(a.item);
      }
      const at = a.link.timing ? a.link.at - a.x0 : a.length;
      await engine.locate(Math.max(0, (at - preroll) * a.rate));
      if (a.link.timing) {
        setStatus(`Preparo “${b.item.title}”…`);
        const ready = await waitFor(() => engineStatus().next?.songId === b.item.id, 30000);
        if (!ready) notify(`“${b.item.title}” non è pronto: la transizione potrebbe non partire`, true);
      }
      setStatus(null);
      await engine.play(false);
    } catch (e) {
      setStatus(null);
      notify(`Prova non riuscita: ${e?.message || e}`, true);
    }
  };

  const go = (dir) => {
    const n = Math.max(0, Math.min(clips.length - 2, (selected ?? 0) + dir));
    setSelected(n);
    if (engineStatus().playing) tryIt(n);
  };

  // Keys: ← → the transitions, Enter tries it, Esc closes.
  const keys = useRef(null);
  keys.current = { go, tryIt, selected, onClose };
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('input, select, textarea')) return;
      const k = keys.current;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        k.go(e.key === 'ArrowLeft' ? -1 : 1);
      } else if (e.key === 'Enter' && k.selected != null) {
        e.preventDefault();
        k.tryIt(k.selected);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        k.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ---------- Editing by hand ----------
  const timeAtClient = (clientX) => (clientX - scroller.current.getBoundingClientRect().left + left.current - PAD_X) / pps;

  // Snap of the start of the song after on the bars of the one before (seconds of the timeline).
  const snapStart = (a, x) => {
    const end = a.x0 + a.length;
    if (!snap) return Math.round(x * 10) / 10;
    if (Math.abs(x - end) * pps < 10) return end;
    if (x > end) return end + Math.round((x - end) * 2) / 2;
    const bar = nearestBar(a.beats, (x - a.x0) * a.rate);
    return bar == null ? x : a.x0 + bar / a.rate;
  };

  // A gesture on a clip: a touch moves the playhead there, a drag moves the song (or a handle).
  const gesture = (e, kind, c) => {
    if (e.button > 0) return;
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const prev = clips[c.index - 1];
    // pic* / snd*: picture or sound of the video item itself, not the transition.
    const own = /^(pic|snd)/.test(kind);
    const a = kind === 'fadeOut' || own ? c : prev;
    let moved = false;
    let fields = null;
    const editable = canEdit && (own || a?.link?.timing);
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - sx) < 5) return;
      moved = true;
      if (!editable) return;
      userAt.current = performance.now();
      const x = timeAtClient(ev.clientX);
      if (own) {
        fields = ownFadePatch(c.item, mediaRef.current[c.index], kind, (x - c.x0) * c.rate, snap);
      } else if (kind === 'body') {
        const from = snapStart(a, c.from + (ev.clientX - sx) / pps);
        fields = offsetPatch(a.link.mode, from - (a.x0 + a.length));
        setSnapLines(snap ? barsOf(a.beats).map((b) => a.x0 + b.t / a.rate) : null);
      } else if (kind === 'trim') {
        // The head of the song after: its content stays where it is, it starts later or earlier.
        const bars = [0, ...barsOf(c.beats).map((b) => b.t)];
        let start = Math.max(0, Math.min(c.duration - 1, (x - c.x0) * c.rate));
        if (snap) start = bars.reduce((best, b) => (Math.abs(b - start) < Math.abs(best - start) ? b : best), 0);
        const from = c.x0 + start / c.rate;
        fields = { ...offsetPatch(a.link.mode, from - (a.x0 + a.length)), linkStart: start > 0.01 ? round2(start) : null };
        setSnapLines(snap ? bars.map((b) => c.x0 + b / c.rate) : null);
      } else if (kind === 'fadeIn') {
        fields = { linkFadeIn: round2(Math.max(0, Math.min(LINK_FADE_MAX, Math.round((x - c.from) * 2) / 2))) };
      } else if (kind === 'fadeOut') {
        const room = Math.max(0, c.x0 + c.length - c.link.at);
        fields = { linkFadeOut: round2(Math.max(0, Math.min(LINK_FADE_MAX, room, Math.round((x - c.link.at) * 2) / 2))) };
      }
      if (fields) setPatch({ id: a.item.id, fields });
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setSnapLines(null);
      if (!moved) {
        if (kind === 'body') {
          // The first part of a song is about the transition into it, the rest about the one after.
          const r = el.getBoundingClientRect();
          const into = c.index > 0 && (ev.clientX - r.left) / Math.max(1, r.width) < 0.3;
          setSelected(Math.max(0, Math.min(clips.length - 2, c.index - (into ? 1 : 0))));
          seek(c, (timeAtClient(ev.clientX) - c.x0) * c.rate);
        }
        return;
      }
      if (fields) {
        write(a.item.id, fields);
        if (!own) setSelected(a.index);
      }
      // The saved values arrive with the next snapshot: the preview stays until then.
      setTimeout(() => setPatch(null), 400);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const sel = clips[selected];
  const after = clips[(selected ?? -1) + 1];
  const X = (t) => PAD_X + t * (pps || 1);
  const laneTop = (lane) => RULER_H + lane * (laneH + LANE_GAP);
  const nowClip = clips.find((c) => c.item.id === (songId || loaded?.itemId));

  return (
    <div className="tr" role="dialog" aria-label="Transizioni della scaletta">
      <header className="tr-top">
        <button className="btn btn-sm btn-ghost" onClick={onClose} title="Torna al Palco (Esc)">
          <Icon name="chevron-left" size={16} /> Palco
        </button>
        <strong className="tr-title">Transizioni</strong>
        <span className="tr-transport">
          <button className="st-round" onClick={() => go(-1)} disabled={!selected} title="Transizione precedente (←)" aria-label="Transizione precedente">
            <Icon name="skip-back" size={18} />
          </button>
          <button className={`st-play ${playing ? 'is-on' : ''}`} onClick={() => (playing ? engine.stop() : player.toggle(nowClip?.item || sel?.item))} title="Play / Stop (Spazio)" aria-label={playing ? 'Stop' : 'Play'}>
            <Icon name={playing ? 'stop' : 'play'} size={24} />
          </button>
          <button className="st-round" onClick={() => go(1)} disabled={selected == null || selected >= clips.length - 2} title="Transizione successiva (→)" aria-label="Transizione successiva">
            <Icon name="skip-forward" size={18} />
          </button>
        </span>
        <span className="tr-now ellipsis">{status || (nowClip ? <NowText clip={nowClip} /> : <span className="muted">Nessun brano caricato</span>)}</span>
        <span className="grow" />
        <button className={`btn btn-sm ${monitorOn ? 'is-on' : ''}`} onClick={toggleMonitor} aria-pressed={monitorOn} title="Mostra qui quello che va sull’uscita video">
          <Icon name="monitor" size={14} /> Monitor
        </button>
        <button className={`btn btn-sm ${snap ? 'is-on' : ''}`} onClick={() => setSnap(!snap)} aria-pressed={snap} title="Il brano dopo si aggancia alle battute di quello prima, l’inizio alle battute del brano">
          <Icon name="grid" size={14} /> Aggancia
        </button>
        <span className="st-view">
          <button className="btn btn-sm btn-icon" onClick={() => zoomBy(1 / 1.5)} title="Riduci lo zoom (Ctrl + rotella, due dita)" aria-label="Riduci lo zoom">
            <Icon name="zoom-out" size={15} />
          </button>
          <button className="btn btn-sm btn-icon" onClick={() => zoomBy(1.5)} title="Aumenta lo zoom (Ctrl + rotella, due dita)" aria-label="Aumenta lo zoom">
            <Icon name="zoom-in" size={15} />
          </button>
          <button className="btn btn-sm btn-icon" onClick={fitAll} title="Tutta la scaletta nella finestra" aria-label="Tutta la scaletta">
            <Icon name="maximize" size={14} />
          </button>
        </span>
      </header>

      <div className="tr-stage" ref={box}>
        <canvas ref={canvas} />
        <div className="tr-scroll" ref={scroller} onScroll={onScroll}>
          <div className="tr-track" style={{ width }}>
            {pps &&
              clips.map((c) => {
                const prev = clips[c.index - 1];
                const linkedIn = !!prev?.link?.timing;
                const st = itemCacheState(c.item, cache);
                const key = playedKey(c.item);
                const change = songChange(c.item);
                // What of the clip went out on the left: its title and the label of its section stay in sight.
                const hidden = Math.max(0, viewLeft - X(c.from));
                return (
                  <div
                    key={c.item.id}
                    className={`tr-clip ${c.index === selected || c.index === selected + 1 ? 'is-on' : ''} ${c.item.id === songId ? 'is-playing' : ''} ${canEdit && linkedIn ? 'can-move' : ''}`}
                    style={{ left: X(c.from), width: Math.max(4, (c.until - c.from) * pps), top: laneTop(c.lane), height: laneH, '--clip': colorOf(c) }}
                    onPointerDown={(e) => gesture(e, 'body', c)}
                    title={canEdit && linkedIn ? 'Tocca per ascoltare da qui, trascina per spostare il brano' : 'Tocca per ascoltare da qui'}
                  >
                    <span className="tr-clip-head" style={{ paddingLeft: 8 + hidden }}>
                      <b className="tr-num">{numbers?.[c.item.id]}</b>
                      {isVideoItem(c.item) && <Icon name="video" size={12} />}
                      <span className="ellipsis">{c.item.title}</span>
                      {key && <b className="tr-key">{keyLabel(key)}</b>}
                      {change.bpm && <span className="tr-bpm">{change.bpm} BPM</span>}
                      {(st === 'partial' || st === 'error') && (
                        <button
                          className="tr-dl"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => ensureItems([c.item]).catch((e) => notify(`Download non riuscito: ${e?.message || e}`, true))}
                          title="Non scaricato su questo computer: scarica per vedere la forma d’onda"
                        >
                          <Icon name="download" size={12} />
                        </button>
                      )}
                    </span>
                    <span className="tr-secs">
                      {c.sections.map((s) => {
                        const x = (c.x0 + s.start / c.rate - c.from) * pps;
                        const w = ((s.end - s.start) / c.rate) * pps;
                        if (x + w - hidden < 14) return null;
                        return (
                          <button
                            key={s.start}
                            className="tr-sec"
                            style={{ left: Math.max(hidden, x), width: w + x - Math.max(hidden, x), '--sec': s.color }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => seek(c, s.start)}
                            title={`${s.label}: ascolta da qui`}
                          >
                            <span className="ellipsis">{s.label}</span>
                          </button>
                        );
                      })}
                    </span>
                  </div>
                );
              })}
            {pps &&
              clips.map((c, i) => {
                const next = clips[i + 1];
                if (!next || c.link?.at == null) return null;
                const t = c.link.timing;
                const label = !t ? transitionLabel(c.link.mode) : t.offset < -0.04 ? `−${fmt(-t.offset)}` : t.offset > 0.04 ? `+${fmt(t.offset)}` : 'Alla fine';
                return (
                  <button
                    key={c.item.id}
                    className={`tr-link tr-link-${c.link.mode} ${i === selected ? 'is-on' : ''} ${nextQueued === next.item.id && loaded?.itemId === c.item.id ? 'is-armed' : ''}`}
                    style={{ left: X(c.link.at), top: RULER_H + laneH + LANE_GAP / 2 }}
                    onClick={() => setSelected(i)}
                    title={`${transitionLabel(c.link.mode)}: “${c.item.title}” → “${next.item.title}”`}
                  >
                    <Icon name={ICON[c.link.mode]} size={12} />
                    <span>{label}</span>
                  </button>
                );
              })}
            {/* Handles of the transition chosen: start of the song after, its fade in, the fade out of the one before. */}
            {pps && canEdit && sel?.link?.timing && after && (
              <>
                <span
                  className="tr-handle tr-trim"
                  style={{ left: X(after.from), top: laneTop(after.lane), height: laneH }}
                  onPointerDown={(e) => gesture(e, 'trim', after)}
                  title="Trascina: il brano dopo parte più avanti o più indietro (le battute del brano)"
                />
                {after.from + (sel.link.timing.fadeIn || 0) <= after.until && (
                  <span
                    className="tr-handle tr-fade"
                    style={{ left: X(after.from + (sel.link.timing.fadeIn || 0)), top: waveTopOf(after.lane) }}
                    onPointerDown={(e) => gesture(e, 'fadeIn', after)}
                    title={`Entrata: ${fmt(sel.link.timing.fadeIn || 0)} (trascina)`}
                  />
                )}
                {sel.link.mode !== 'autolink' && (
                  <span
                    className="tr-handle tr-fade is-out"
                    style={{ left: X(sel.link.at + (sel.link.timing.fadeOut || 0)), top: waveTopOf(sel.lane) }}
                    onPointerDown={(e) => gesture(e, 'fadeOut', sel)}
                    title={`Uscita: ${sel.link.timing.fadeOut ? fmt(sel.link.timing.fadeOut) : 'fino alla fine'} (trascina)`}
                  />
                )}
              </>
            )}
            {/* Video items of the transition chosen: fades and end of the picture (strip on top) and of the sound (waveform). */}
            {pps &&
              canEdit &&
              [sel, after].map((c) => {
                const m = c && isVideoItem(c.item) ? media[c.index] : null;
                if (!m?.pic) return null;
                const vx = (v) => X(c.x0 + (m.offset + v) / c.rate);
                const pStop = fadeStop(m.pic, m.file);
                const sStop = fadeStop(m.sound, m.file);
                // Sound handles after the fade out of the transition: not heard, not shown.
                const heard = (v) => c.x0 + (m.offset + v) / c.rate <= c.until + 0.01;
                const waveTop = waveTopOf(c.lane);
                const vidTop = vidTopOf(c.lane);
                const name = `“${c.item.title}”`;
                return (
                  <span key={`own-${c.item.id}`} className="tr-own">
                    <span className="tr-handle tr-fade is-pic" style={{ left: vx(m.pic.in), top: vidTop + 3 }} onPointerDown={(e) => gesture(e, 'picIn', c)} title={`Immagine di ${name}, entrata: ${fmt(m.pic.in)} (trascina)`} />
                    <span className="tr-handle tr-fade is-pic is-out" style={{ left: vx(pStop - m.pic.out), top: vidTop + 3 }} onPointerDown={(e) => gesture(e, 'picOut', c)} title={`Immagine di ${name}, uscita: ${fmt(m.pic.out)} (trascina)`} />
                    <span className="tr-handle tr-trim is-pic" style={{ left: vx(pStop), top: vidTop, height: VID_H }} onPointerDown={(e) => gesture(e, 'picEnd', c)} title={`Fine dell’immagine di ${name} (trascina: l’audio non cambia)`} />
                    <span className="tr-handle tr-fade is-snd" style={{ left: vx(m.sound.in), top: waveTop }} onPointerDown={(e) => gesture(e, 'sndIn', c)} title={`Audio di ${name}, entrata: ${fmt(m.sound.in)} (trascina)`} />
                    {heard(sStop - m.sound.out) && <span className="tr-handle tr-fade is-snd is-out" style={{ left: vx(sStop - m.sound.out), top: waveTop }} onPointerDown={(e) => gesture(e, 'sndOut', c)} title={`Audio di ${name}, uscita: ${fmt(m.sound.out)} (trascina)`} />}
                    {heard(sStop) && <span
                      className="tr-handle tr-trim is-snd"
                      style={{ left: vx(sStop), top: waveTop, height: laneTop(c.lane) + laneH - waveTop }}
                      onPointerDown={(e) => gesture(e, 'sndEnd', c)}
                      title={`Fine dell’audio di ${name} (trascina: l’immagine non cambia)`}
                    />}
                  </span>
                );
              })}
            <span className="tr-head" ref={head} />
          </div>
        </div>
        {clips.length < 2 && <div className="tr-empty muted">Servono almeno due brani nella scaletta per una transizione.</div>}
      </div>

      {((sel && after) || monitorOn) && (
        <div className="tr-bottom">
          {sel && after ? (
            <Inspector
              a={sel}
              b={after}
              media={media}
              canEdit={canEdit}
              write={write}
              preroll={preroll}
              setPreroll={setPreroll}
              onTry={() => tryIt(selected)}
              onSeekB={(t) => seek(after, t)}
              busy={!!status}
            />
          ) : (
            <span className="grow" />
          )}
          {monitorOn && (
            <div className="tr-monitor" title="Uscita video: quello che vede il pubblico">
              <VideoOutput className="tr-monitor-screen">
                {({ source, tail }) => !source?.src && !source?.still && !tail && <span className="tr-monitor-empty">Schermo nero</span>}
              </VideoOutput>
              <span className="tr-monitor-label">Uscita video</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NowText({ clip }) {
  const pos = useEngineStatus((s) => Math.floor(Math.max(0, s.position)));
  return (
    <>
      <b>{clip.item.title}</b>
      <span className="muted mono">
        {' '}
        {clockText(pos / clip.rate)} / {clockText(clip.length)}
      </span>
    </>
  );
}

// Value with − and + (and a bar on each side when there is one).
function Stepper({ label, text, onStep, bar, canEdit, min, max, value }) {
  return (
    <div className="tr-step">
      <span className="tr-step-label">{label}</span>
      <span className="tr-step-ctl">
        {bar && (
          <button className="btn btn-sm" onClick={() => onStep(-bar)} disabled={!canEdit || value <= min} title="Una battuta in meno">
            −1 batt.
          </button>
        )}
        <button className="btn btn-sm btn-icon" onClick={() => onStep(-0.5)} disabled={!canEdit || value <= min} aria-label={`${label}: meno`}>
          <Icon name="minus" size={13} />
        </button>
        <b className="tr-step-val">{text}</b>
        <button className="btn btn-sm btn-icon" onClick={() => onStep(0.5)} disabled={!canEdit || value >= max} aria-label={`${label}: più`}>
          <Icon name="plus" size={13} />
        </button>
        {bar && (
          <button className="btn btn-sm" onClick={() => onStep(bar)} disabled={!canEdit || value >= max} title="Una battuta in più">
            +1 batt.
          </button>
        )}
      </span>
    </div>
  );
}

// The transition chosen: type, values, where the song after starts, and Prova.
// Picture and sound of a video item of the transition chosen: fade in, fade out and end
// of each, together (the sound follows the picture) or apart.
function OwnVideo({ c, m, canEdit, write }) {
  const apart = audioApart(c.item);
  const set = (fields) => canEdit && write(c.item.id, fields);
  const step = (kind, fades, key, d) => {
    const stop = fadeStop(fades, m.file);
    // As a handle at the value it gives, in seconds of the song.
    const at = key === 'In' ? fades.in + d : key === 'Out' ? stop - (fades.out + d) : stop + d;
    set(ownFadePatch(c.item, m, kind + key, m.offset + at, false));
  };
  const row = (kind, label, fades, hint) => {
    const stop = fadeStop(fades, m.file);
    return (
      <div className="tr-own-row" title={hint}>
        <span className={`tr-own-name is-${kind}`}>{label}</span>
        <Stepper label="Entrata" text={fades.in ? `${fmt(fades.in)}` : 'Netta'} value={fades.in} min={0} max={Math.min(VIDEO_FADE_MAX, stop)} canEdit={canEdit} onStep={(d) => step(kind, fades, 'In', d)} />
        <Stepper label="Uscita" text={fades.out ? `${fmt(fades.out)}` : 'Netta'} value={fades.out} min={0} max={Math.min(VIDEO_FADE_MAX, stop)} canEdit={canEdit} onStep={(d) => step(kind, fades, 'Out', d)} />
        <Stepper label="Finisce a" text={fades.end ? clockTenths(fades.end) : 'Fine del video'} value={stop} min={1} max={m.file} canEdit={canEdit} onStep={(d) => step(kind, fades, 'End', d)} />
      </div>
    );
  };
  return (
    <div className="tr-own-video">
      <div className="tr-own-head">
        <Icon name="video" size={14} />
        <b className="ellipsis">{c.item.title}</b>
        <button
          className={`btn btn-sm ${apart ? '' : 'is-on'}`}
          onClick={() => set(apart ? SOUND_TOGETHER : apartFields(c.item))}
          disabled={!canEdit}
          aria-pressed={!apart}
          title={apart ? 'Audio e immagine separati: premi perché l’audio segua di nuovo l’immagine' : 'L’audio segue l’immagine: premi per regolarli separatamente'}
        >
          <Icon name="link" size={13} /> {apart ? 'Separati' : 'Insieme'}
        </button>
      </div>
      {row('pic', 'Immagine', m.pic, 'Dissolvenze e fine dell’immagine: dopo la fine si vede l’immagine della scaletta')}
      {row('snd', 'Audio', m.sound, apart ? 'Dissolvenze e fine dell’audio del video' : 'Ora segue l’immagine: se lo cambi, l’audio diventa separato')}
    </div>
  );
}

function Inspector({ a, b, media, canEdit, write, preroll, setPreroll, onTry, onSeekB, busy }) {
  const mode = a.link.mode;
  const t = a.link.timing;
  const start = Number(a.item.linkStart) || 0;
  const set = (fields) => canEdit && write(a.item.id, fields);
  const offsetText = !t ? '' : t.offset < -0.04 ? `${fmt(-t.offset)} prima della fine` : t.offset > 0.04 ? `Pausa di ${fmt(t.offset)}` : 'Alla fine';
  return (
    <section className="tr-panel">
      <div className="tr-panel-head">
        <span className="tr-pair ellipsis">
          <b>{a.item.title}</b>
          <Icon name="chevron-right" size={14} />
          <b>{b.item.title}</b>
        </span>
        <span className="tr-types" role="group" aria-label="Tipo di transizione">
          {TRANSITIONS.map(([k, label, hint]) => (
            <button key={k} className={`tr-type ${mode === k ? 'is-on' : ''}`} onClick={() => set({ transition: k, ...LINK_RESET })} disabled={!canEdit} title={hint}>
              <Icon name={ICON[k]} size={14} />
              <span>{label}</span>
            </button>
          ))}
        </span>
      </div>
      <div className="tr-panel-body">
        {t ? (
          <>
            <Stepper
              label="Il brano dopo parte"
              text={offsetText}
              value={t.offset}
              min={-a.length}
              max={LINK_PAUSE_MAX}
              bar={barSeconds(a)}
              canEdit={canEdit}
              onStep={(d) => set(offsetPatch(mode, t.offset + d))}
            />
            {mode !== 'autolink' && (
              <Stepper
                label="Uscita"
                text={t.fadeOut ? `Sfuma in ${fmt(t.fadeOut)}` : 'Fino alla fine'}
                value={t.fadeOut}
                min={0}
                max={LINK_FADE_MAX}
                canEdit={canEdit}
                onStep={(d) => set({ linkFadeOut: round2(Math.max(0, Math.min(LINK_FADE_MAX, t.fadeOut + d))) })}
              />
            )}
            <Stepper
              label="Entrata"
              text={t.fadeIn ? `Cresce in ${fmt(t.fadeIn)}` : 'Netta'}
              value={t.fadeIn}
              min={0}
              max={LINK_FADE_MAX}
              canEdit={canEdit}
              onStep={(d) => set({ linkFadeIn: round2(Math.max(0, Math.min(LINK_FADE_MAX, t.fadeIn + d))) })}
            />
          </>
        ) : (
          <p className="tr-hint muted">
            {mode === 'cue' ? 'A fine brano il successivo viene caricato e parte quando premi Play.' : 'A fine brano resta questo: il successivo lo scegli tu.'} Per collegarli scegli AutoLink, Sovrapponi o Dissolvenza.
          </p>
        )}
        {mode !== 'stay' && (
          <div className="tr-step tr-from">
            <span className="tr-step-label">“{b.item.title}” parte da</span>
            <span className="tr-chips">
              <button className={`toggle ${start < 0.01 ? 'is-on' : ''}`} onClick={() => set({ linkStart: null })} disabled={!canEdit}>
                Inizio
              </button>
              {b.sections
                .filter((s) => s.start > 0.01)
                .map((s) => (
                  <button
                    key={s.start}
                    className={`toggle ${Math.abs(start - s.start) < 0.05 ? 'is-on' : ''}`}
                    style={{ '--sec': s.color }}
                    onClick={() => set({ linkStart: round2(s.start) })}
                    onDoubleClick={() => onSeekB(s.start)}
                    disabled={!canEdit}
                    title={`Batt. ${s.bar}`}
                  >
                    <i className="tr-dot" />
                    {s.label}
                  </button>
                ))}
            </span>
          </div>
        )}
        {[a, b].map((c) => (isVideoItem(c.item) && media?.[c.index]?.pic ? <OwnVideo key={c.item.id} c={c} m={media[c.index]} canEdit={canEdit} write={write} /> : null))}
        <span className="grow" />
        <div className="tr-try">
          <span className="tr-chips" role="group" aria-label="Da quanto prima">
            {PREROLLS.map((s) => (
              <button key={s} className={`toggle ${preroll === s ? 'is-on' : ''}`} onClick={() => setPreroll(s)} title={`Parte ${s} secondi prima della transizione`}>
                −{s} s
              </button>
            ))}
          </span>
          <button className="btn btn-primary" onClick={onTry} disabled={busy} title="Ascolta la fine del brano e la transizione (Invio)">
            <Icon name="play" size={14} /> Prova
          </button>
          {canEdit && (t?.own || start > 0) && (
            <button className="btn btn-sm btn-ghost" onClick={() => set({ ...LINK_RESET, linkStart: null })} title="Torna ai valori del tipo scelto">
              <Icon name="undo" size={13} /> Valori del tipo
            </button>
          )}
        </div>
      </div>
      {!canEdit && <p className="tr-hint muted">Solo chi modifica la scaletta può cambiare le transizioni: qui puoi provarle.</p>}
    </section>
  );
}
