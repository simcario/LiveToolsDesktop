// Gobbo (lyrics prompter). Slides and timed changes are made in LiveTools
// Desktop and stored on the song (`prompter`):
//   { slides: [{ id, label, text }], order: [slideId], cues: [{ t, slide }] }
// The slide on screen right now is published on the setlist
// (`live.prompter`) by whoever leads it: the desktop that plays the song with
// "Guida" on, or a web operator. Every phone and tablet shows it in sync:
//   { itemId, slide, next, by, byName, source: 'desktop' | 'web', at }
// No Firebase here: the desktop output window uses this file too.

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
