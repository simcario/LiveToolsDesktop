// The setlist as a timeline (Transizioni page): every song laid out in the seconds
// heard, one after the other as the transitions chain them, with its waveform and
// its sections, also for the songs not in the player.
import { isSeparator } from '../shared/setlists.js';
import { isVideoItem, padHoldOf, padLeadOf, regionsOf, stemsOf, videoAudioStem, videoOf } from '../shared/media.js';
import { songSections } from './sections';
import { isLinked, lastSectionStart, linkTiming, songChange, transitionOf } from './songChange';

// Seconds drawn between two songs that are not linked: the next one waits for Play.
export const MANUAL_GAP = 6;

const num = (v) => (Number(v) > 0 ? Number(v) : null);
const beatsOf = (timeSig) => {
  const n = parseInt(String(timeSig || '4/4').split('/')[0], 10);
  return n > 0 && n <= 16 ? n : 4;
};
// Compound metres (6/8, 9/8, 12/8) click in eighths, the tempo being in dotted quarters.
const beatSeconds = (bpm, timeSig) => {
  const [n, d] = String(timeSig || '4/4').split('/').map(Number);
  return 60 / bpm / (d === 8 && n % 3 === 0 && n > 3 ? 3 : 1);
};
const placed = (item) => (item?.sections || []).filter((s) => Number(s.bars) >= 1);

/**
 * Beats of a song not in the player, from bar 1: [{ t, bar, inBar }] in original seconds.
 * From the bars the desktop publishes (item.beatMap, lib/beatMap.js) or else from tempo,
 * metre and sections (as the Player palco of the web, web/src/lib/stage-grid.js).
 */
export function itemBeats(item, duration) {
  if (!(duration > 0)) return [];
  const out = [];
  const map = item?.beatMap;
  if (map?.v === 1 && Array.isArray(map.bars) && map.bars.length >= 2) {
    const per = (i) => (Array.isArray(map.beats) ? map.beats[i] || 4 : map.beats || 4);
    map.bars.forEach((t, i) => {
      const n = per(i);
      const next = map.bars[i + 1];
      const beat = next != null ? (next - t) / n : map.tail || 0.5;
      for (let k = 0; k < n; k += 1) out.push({ t: t + k * beat, bar: i + 1, inBar: k });
    });
    const n = per(map.bars.length - 1);
    let t = out.at(-1).t + (map.tail || 0.5);
    let bar = map.bars.length;
    let k = out.at(-1).inBar + 1;
    while (t < duration) {
      if (k >= n) {
        k = 0;
        bar += 1;
      }
      out.push({ t, bar, inBar: k });
      t += map.tail || 0.5;
      k += 1;
    }
    return out.filter((b) => b.t < duration);
  }
  const base = { bpm: num(item?.grid?.bpm) || num(item?.bpm) || 120, timeSig: item?.timeSig || '4/4' };
  const plan = placed(item).map((s) => ({ bars: Math.floor(Number(s.bars)), bpm: num(s.bpm) || base.bpm, timeSig: s.timeSig || base.timeSig }));
  let t = 0;
  let bar = 1;
  const push = ({ bpm, timeSig }) => {
    const n = beatsOf(timeSig);
    const beat = beatSeconds(bpm, timeSig);
    for (let k = 0; k < n; k += 1) out.push({ t: t + k * beat, bar, inBar: k });
    t += n * beat;
    bar += 1;
  };
  plan.forEach((s) => {
    for (let i = 0; i < s.bars && t < duration; i += 1) push(s);
  });
  const last = plan.at(-1) || base;
  while (t < duration) push(last);
  return out.filter((b) => b.t < duration);
}

/** The files of a song for its waveform: [{ stem, local }] (local null when not on this computer). */
export function songTracks(item, cache, loaded) {
  if (loaded?.itemId === item.id) return loaded.tracks;
  const localOf = (path) => (path && cache[path]?.ready ? cache[path].local || null : null);
  const list = stemsOf(item).map((stem) => ({ stem, local: localOf(stem.path) }));
  const video = isVideoItem(item) && videoOf(item);
  if (video) list.push({ stem: videoAudioStem(item), local: localOf(video.path) });
  return list;
}

/** Where the files of a song play: the regions of the Arrangement, the sound of a video at its offset. */
export function songRegions(item) {
  const video = isVideoItem(item) && videoOf(item);
  return video ? { ...regionsOf(item), 'video-audio': [{ at: Number(video.offset) || 0, from: 0, len: null }] } : regionsOf(item);
}

const audible = ({ stem }) => {
  const role = stem.role || 'main';
  return role !== 'click' && role !== 'guide' && stem.generated !== 'cues';
};

/** Length of a song not in the player (original seconds), from its files, or else its stated duration. */
export function songLength(item, tracks, peaks, regions) {
  let end = 0;
  tracks.forEach(({ stem, local }) => {
    const p = local && peaks[local];
    if (!p) return;
    const pieces = regions[stem.id]?.length ? regions[stem.id] : [{ at: 0, from: 0 }];
    pieces.forEach((r) => {
      const len = r.len ?? Math.max(0, p.duration - (r.from || 0));
      end = Math.max(end, (r.at || 0) + len);
    });
  });
  return end > 0 ? end : num(item.duration) || 180;
}

/**
 * Levels (0..255) of the stems summed, one per pixel: `width` pixels from `t0`
 * (original seconds of the song), `secPerPx` each. As the waveform of the Palco.
 */
export function songLevels(tracks, peaks, regions, t0, secPerPx, width) {
  const levels = new Float32Array(Math.max(0, Math.ceil(width)));
  tracks.filter(audible).forEach(({ stem, local }) => {
    const p = local && peaks[local];
    if (!p) return;
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
  return levels;
}

/**
 * The setlist laid out: { clips, total } in seconds heard from the start of the setlist.
 * A clip: { item, index, lane, rate, duration (original s), length (s heard), x0 (where its
 * second 0 falls), from (where it starts being heard), until (where it stops: its end, or the
 * end of its fade out under the next one), sections, beats, link (to the next one) }.
 * info(item) gives { duration, beats, lastStart } of a song (the loaded one from the engine).
 * patch: { [itemId]: fields } changes not saved yet (a drag in progress).
 */
export function layoutSetlist(items, settings, info, patch = {}) {
  const songs = items.filter((i) => !isSeparator(i)).map((i) => (patch[i.id] ? { ...i, ...patch[i.id] } : i));
  const clips = [];
  let cursor = 0;
  songs.forEach((item, index) => {
    const prev = clips[index - 1];
    const { duration, beats, lastStart } = info(item);
    const rate = songChange(item).rate || 1;
    const length = duration / rate;
    let from = cursor;
    let start = 0; // original seconds of this song where it starts
    if (prev) {
      const mode = prev.link.mode;
      start = mode === 'stay' ? 0 : Math.max(0, Math.min(duration - 1, Number(prev.item.linkStart) || 0));
      from = prev.link.timing ? prev.x0 + prev.length + prev.link.timing.offset : prev.x0 + prev.length + MANUAL_GAP;
      prev.link.at = from;
      // A fade out ends the song before under this one.
      if (prev.link.timing?.fadeOut > 0) prev.until = Math.min(prev.until, from + prev.link.timing.fadeOut);
    }
    const x0 = from - start / rate;
    const mode = transitionOf(item, settings);
    const next = songs[index + 1] || null;
    const timing = next && isLinked(mode) ? linkTiming(item, mode, { duration, rate, lastStart: lastStart ?? lastSectionOf(beats, item, duration) }, next) : null;
    clips.push({
      item,
      index,
      lane: index % 2,
      rate,
      duration,
      length,
      x0,
      from,
      start,
      until: x0 + length,
      beats,
      sections: songSections(item, beats, duration),
      link: next ? { mode, timing, own: !!timing?.own || !!item.transition, at: null } : null,
      pad: padOf(item, x0, length),
    });
    cursor = x0 + length;
  });
  const total = clips.reduce((m, c) => Math.max(m, c.until, c.x0 + c.length), 0);
  return { clips, total };
}

// Start of the last section from the beats (a song not in the player has no tempo map).
function lastSectionOf(beats, item, duration) {
  const s = songSections(item, beats, duration);
  return s.length > 1 ? s.at(-1).start : null;
}

// The pad of a video item: from `lead` seconds before its end, on into the next song.
function padOf(item, x0, length) {
  const lead = padLeadOf(item);
  if (lead == null || !isVideoItem(item)) return null;
  const hold = padHoldOf(item);
  return { at: x0 + Math.max(0, length - lead), hold: hold?.hold ?? null, fadeOut: hold?.fadeOut ?? null };
}

/** Clip and time (original seconds of its song) at `x` seconds of the timeline, on a lane. */
export function clipAt(clips, x, lane) {
  const on = clips.filter((c) => c.lane === lane && x >= c.x0 && x <= c.x0 + c.length);
  const c = on.at(-1);
  return c ? { clip: c, t: Math.max(0, Math.min(c.duration, (x - c.x0) * c.rate)) } : null;
}

export { lastSectionStart };
