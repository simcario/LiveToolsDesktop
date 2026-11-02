// The bars of the tempo map, published on the setlist item (`beatMap`) for the
// Player palco of the web app: the grid of the desktop comes from the analysis of
// the click stem (kept on this computer), the web lands its jumps on the same bars.
//   { v: 1, bars: [seconds of each bar line from bar 1], beats: n | [n per bar], tail: seconds of a beat after the last bar }
import { doc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { gridBeats } from './grid';

const r4 = (t) => Math.round(t * 10000) / 10000;

export function beatMapOf(tempo, duration) {
  if (!tempo || !(duration > 0)) return null;
  const beats = gridBeats(tempo, tempo.origin - 1, duration).filter((b) => b.g != null);
  const bars = [];
  const counts = [];
  beats.forEach((b) => {
    if (b.inBar === 0) {
      bars.push(r4(b.t));
      counts.push(0);
    }
    if (counts.length) counts[counts.length - 1] += 1;
  });
  if (bars.length < 2) return null;
  const last = beats.at(-1)?.seg;
  const same = counts.slice(0, -1).every((n) => n === counts[0]);
  return { v: 1, bars, beats: same ? counts[0] : counts, tail: r4(last?.beat || 0.5) };
}

// Written only when it changes, without touching updatedAt: it is derived data,
// not an edit of the song.
export function publishBeatMap(setlistId, item, map) {
  if (!map || JSON.stringify(item.beatMap ?? null) === JSON.stringify(map)) return Promise.resolve(false);
  return updateDoc(doc(db, 'setlists', setlistId, 'items', item.id), { beatMap: map }).then(() => true);
}
