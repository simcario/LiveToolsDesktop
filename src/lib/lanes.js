// Session grid: one column ("lane") per stem name across the whole setlist,
// like the tracks of an Ableton Live set. Click and guides come first.
import { stemsOf } from '../shared/media.js';

export const ROLE_COLORS = {
  click: '#06b6d4',
  guide: '#8b5cf6',
  monitor: '#22c55e',
  video: '#e04fd0',
};

// Main stems get distinct warm/bright colors, stable by lane order.
const MAIN_PALETTE = ['#f59e0b', '#fb923c', '#f43f5e', '#e879f9', '#84cc16', '#38bdf8', '#fbbf24', '#2dd4bf', '#a78bfa', '#f472b6'];

const ROLE_ORDER = { click: 0, guide: 1, monitor: 2, main: 3 };

export const laneKey = (stem) => (stem?.name || '').trim().toLowerCase();

export function buildLanes(songs) {
  const map = new Map();
  let order = 0;
  songs.forEach((song) =>
    stemsOf(song).forEach((s) => {
      const key = laneKey(s);
      if (!map.has(key)) map.set(key, { key, name: s.name.trim(), role: s.role || 'main', order: order++ });
    }),
  );
  const lanes = [...map.values()].sort(
    (a, b) => (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || a.order - b.order,
  );
  let m = 0;
  return lanes.map((l) => ({ ...l, color: ROLE_COLORS[l.role] || MAIN_PALETTE[m++ % MAIN_PALETTE.length] }));
}

export function laneColor(lanes, stem) {
  return lanes.find((l) => l.key === laneKey(stem))?.color || ROLE_COLORS[stem.role] || MAIN_PALETTE[0];
}
