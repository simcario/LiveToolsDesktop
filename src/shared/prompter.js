// Gobbo (lyrics prompter). Slides and timed changes are made in LiveTools
// Desktop and stored on the song (`prompter`):
//   { slides: [{ id, label, text, tags? }], order: [slideId], cues: [{ t, slide }] }
// tags: coloured directions shown on every gobbo with the slide, [{ label, color }].
// The slide on screen right now is published on the setlist
// (`live.prompter`) by whoever leads it: the desktop that plays the song with
// "Guida" on, or a web operator. Every phone and tablet shows it in sync:
//   { itemId, slide, next, by, byName, source: 'desktop' | 'web', at }
// No Firebase here: the desktop output window uses this file too.

// Directions on the gobbo (tags of a slide): ready-made ones, and the colours for new ones.
export const TAG_COLORS = ['#f472b6', '#60a5fa', '#a78bfa', '#f59e0b', '#22d3ee', '#f43f5e', '#fb923c', '#84cc16', '#94a3b8', '#facc15'];
export const TAG_PRESETS = [
  { label: 'Voce femminile', color: '#f472b6' },
  { label: 'Voce maschile', color: '#60a5fa' },
  { label: 'Tutti', color: '#a78bfa' },
  { label: 'Solo', color: '#f59e0b' },
  { label: 'Coro', color: '#22d3ee' },
  { label: 'Finale', color: '#f43f5e' },
  { label: 'Rallenta', color: '#fb923c' },
  { label: 'Ripeti', color: '#84cc16' },
  { label: 'Strumentale', color: '#94a3b8' },
  { label: 'Stop', color: '#facc15' },
];
const HEX = /^#[0-9a-f]{6}$/i;

/** The tags of a slide, cleaned: at most 4, with a label and a colour. */
export function slideTags(slide) {
  return (Array.isArray(slide?.tags) ? slide.tags : [])
    .map((t) => ({ label: String(t?.label || '').trim().slice(0, 32), color: HEX.test(t?.color) ? t.color : TAG_COLORS[0] }))
    .filter((t) => t.label)
    .slice(0, 4);
}

// Coloured words in a slide (who sings what): the text carries [rosa]…[/] marks, put by the
// colour buttons of the editor on the selected words. A colour goes on across lines until [/].
export const TEXT_COLORS = [
  ['rosa', '#f472b6'],
  ['blu', '#60a5fa'],
  ['viola', '#a78bfa'],
  ['ambra', '#f59e0b'],
  ['azzurro', '#22d3ee'],
  ['rosso', '#f43f5e'],
  ['arancio', '#fb923c'],
  ['verde', '#84cc16'],
  ['giallo', '#facc15'],
];
const COLOR_OF = Object.fromEntries(TEXT_COLORS);
// [rosa] coloured words, [evid rosa] highlighted words (coloured background), [/] back to normal.
const MARK = new RegExp(`\\[(?:(evid) )?(${TEXT_COLORS.map(([n]) => n).join('|')})\\]|\\[/\\]`, 'gi');

/** The slide text without the colour marks. */
export const plainSlideText = (text) => (text || '').replace(MARK, '');

/**
 * The lines of a slide as runs of text: { text, color, mark } (color null = the colour of the
 * gobbo; mark = highlighted, the colour is the background).
 */
export function slideLines(text) {
  const src = text || '';
  const lines = [[]];
  let style = { color: null, mark: false };
  const push = (chunk) =>
    chunk.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, ...style });
    });
  let at = 0;
  for (const m of src.matchAll(MARK)) {
    push(src.slice(at, m.index));
    style = m[2] ? { color: COLOR_OF[m[2].toLowerCase()], mark: !!m[1] } : { color: null, mark: false };
    at = m.index + m[0].length;
  }
  push(src.slice(at));
  return lines;
}

/** `text` with the characters `from`–`to` (of the text with its marks) coloured (`mark`: highlighted) `name`. */
export function colorSlideText(text, from, to, name, mark = false) {
  if (from === to) return text;
  return `${text.slice(0, from)}[${mark ? 'evid ' : ''}${name}]${text.slice(from, to)}[/]${text.slice(to)}`;
}

/** Black or white text on a tag of colour `hex`. */
export function tagInk(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? '#0b0f17' : '#fff';
}

export const SLIDE_COLORS = ['#f59e0b', '#22d3ee', '#a78bfa', '#f43f5e', '#84cc16', '#fb923c', '#e879f9', '#38bdf8', '#2dd4bf', '#fbbf24'];

export function normalizePrompter(p) {
  const slides = (p?.slides || []).filter((s) => s?.id);
  const ids = new Set(slides.map((s) => s.id));
  return {
    slides,
    order: (p?.order || []).filter((id) => ids.has(id)),
    cues: (p?.cues || [])
      .filter((c) => Number.isFinite(c?.t) && (c.slide === null || ids.has(c.slide)))
      .sort((a, b) => a.t - b.t),
  };
}

export const slideName = (slides, id) => {
  const i = slides.findIndex((s) => s.id === id);
  if (i < 0) return 'Vuota';
  return slides[i].label?.trim() || `Slide ${i + 1}`;
};

export const slideColor = (slides, id) => {
  const i = slides.findIndex((s) => s.id === id);
  return i < 0 ? null : SLIDE_COLORS[i % SLIDE_COLORS.length];
};

/** Index of the cue active at time t (-1 = before the first one). */
export function cueIndexAt(cues, t) {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Slide shown and the next one at cue index i (before the first change, the first slide is "next"). */
export function slidesAtCue(cues, i) {
  const slide = i >= 0 ? cues[i].slide : null;
  const next = cues.slice(i + 1).find((c) => c.slide && c.slide !== slide)?.slide ?? null;
  return { slide, next };
}

// The network adds a little delay: slides go out this much earlier.
export const NETWORK_LEAD = 0.15;

/** Field update that publishes the slide on screen (`updateDoc(setlistRef, …)`). */
export function liveSlideUpdate(user, source, itemId, slide, next) {
  const email = (user?.email || '').toLowerCase();
  return {
    'live.prompter': {
      itemId,
      slide: slide ?? null,
      next: next ?? null,
      by: email,
      byName: user?.displayName || email,
      source,
      at: Date.now(),
    },
  };
}
