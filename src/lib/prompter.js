// Gobbo (lyrics prompter): the song's text split into slides, and the slide
// changes recorded against the audio clock. Stored on the song document
// (`prompter` field) so every computer of the band shows the same timing:
//   { slides: [{ id, label, text }], order: [slideId], cues: [{ t, slide }] }
// `order` is the planned sequence (a chorus appears in it more than once),
// `cues` the recorded changes: t = seconds of the song, slide = id or null (blank).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { newId } from '../shared/setlists.js';
import { lyricBlocksText, songLyricBlocks } from '../shared/music.js';
import {
  cueIndexAt,
  liveSlideUpdate,
  NETWORK_LEAD,
  normalizePrompter,
  SLIDE_COLORS,
  slideColor,
  slideName,
  slidesAtCue,
} from '../shared/prompter.js';
import { db } from './firebase';
import { useEngineStatus } from './engine';

export { cueIndexAt, normalizePrompter, SLIDE_COLORS, slideColor, slideName };

export const EMPTY_PROMPTER = { slides: [], order: [], cues: [] };

export const songLyricsText = (item) => lyricBlocksText(songLyricBlocks(item));

const textKey = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Splits the song lyrics (its own text or the chart, see songLyricBlocks)
 * into slides of at most `maxLines` lines (0 = one per block). Repeated
 * blocks (a chorus) become a single slide used more times in `order`.
 */
export function autoPrompter(item, maxLines) {
  const slides = [];
  const order = [];
  const byText = new Map();
  songLyricBlocks(item).forEach((b) => {
    const n = maxLines > 0 ? Math.ceil(b.lines.length / maxLines) : 1;
    const per = Math.ceil(b.lines.length / n);
    for (let i = 0; i < n; i += 1) {
      const text = b.lines.slice(i * per, (i + 1) * per).join('\n');
      const key = textKey(text);
      let id = byText.get(key);
      if (!id) {
        id = newId();
        byText.set(key, id);
        slides.push({ id, label: n > 1 && b.label ? `${b.label} ${i + 1}/${n}` : b.label, text });
      }
      order.push(id);
    }
  });
  return { slides, order, cues: [] };
}

/** Recorded take replaces the old cues between `from` and `to` (punch in/out). */
export function punch(cues, take, from, to) {
  return [...cues.filter((c) => c.t < from || c.t > to), ...take].sort((a, b) => a.t - b.t);
}

/** Inserts a cue, replacing one within 50 ms; drops a repeat of the slide just before. */
export function insertCue(cues, cue) {
  const rest = cues.filter((c) => Math.abs(c.t - cue.t) > 0.05);
  const i = cueIndexAt(rest, cue.t);
  if (i >= 0 && rest[i].slide === cue.slide) return rest;
  return [...rest, cue].sort((a, b) => a.t - b.t);
}

// Consecutive cues on the same slide say nothing new.
export function compactCues(cues) {
  return cues.filter((c, i) => i === 0 || cues[i - 1].slide !== c.slide);
}

/**
 * Prompter data of a song, edited locally and saved (debounced) on the song.
 * Remote changes are adopted when nothing is waiting to be saved.
 */
export function usePrompterData(setlistId, item, canEdit, notify) {
  const itemId = item?.id;
  const remote = item?.prompter;
  const [state, setState] = useState(() => ({ itemId, data: normalizePrompter(remote) }));
  const pending = useRef(null); // { setlistId, itemId, data, timer }

  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    updateDoc(doc(db, 'setlists', p.setlistId, 'items', p.itemId), { prompter: p.data, updatedAt: serverTimestamp() }).catch((e) =>
      notify(`Gobbo non salvato: ${e.message}`, true),
    );
  }, [notify]);

  useEffect(() => {
    if (pending.current?.itemId === itemId) return;
    setState({ itemId, data: normalizePrompter(remote) });
  }, [itemId, remote]);

  useEffect(() => flush, [itemId, flush]);

  const update = useCallback(
    (fn) => {
      if (!canEdit || !itemId) return;
      setState((cur) => {
        const data = normalizePrompter(typeof fn === 'function' ? fn(cur.data) : fn);
        clearTimeout(pending.current?.timer);
        pending.current = { setlistId, itemId, data, timer: setTimeout(flush, 700) };
        return { itemId, data };
      });
    },
    [canEdit, itemId, setlistId, flush],
  );

  const data = state.itemId === itemId ? state.data : normalizePrompter(remote);
  return [data, update];
}

// ---------- Output window ----------
// The prompter view publishes what it is editing (also the take being
// recorded); otherwise the output shows the saved data of the loaded song.

let override = null;
const overrideListeners = new Set();

export function setPrompterOverride(value) {
  override = value;
  overrideListeners.forEach((f) => f());
}

function useOverride() {
  return useSyncExternalStore(
    (f) => {
      overrideListeners.add(f);
      return () => overrideListeners.delete(f);
    },
    () => override,
  );
}

/** Prompter data of the song in the player: what the Gobbo view is editing, or the saved one. */
function useLoadedPrompter(loadedItem) {
  const live = useOverride();
  return live && live.itemId === loadedItem?.id ? live.data : loadedItem?.prompter;
}

export function usePrompterOutput(loadedItem, settings) {
  const data = useLoadedPrompter(loadedItem);
  const payload = loadedItem
    ? { itemId: loadedItem.id, title: loadedItem.title, lead: settings.prompterLead, showNext: settings.prompterNext, ...normalizePrompter(data) }
    : null;
  const json = JSON.stringify(payload);
  useEffect(() => {
    const p = JSON.parse(json);
    emit('prompter-source', p);
    const un = listen('prompter-hello', () => emit('prompter-source', p));
    return () => {
      un.then((f) => f());
    };
  }, [json]);
}

// ---------- Gobbo on the band's phones and tablets ----------
// The computer that leads the band ("Guida") publishes the slide on screen on
// the setlist (live.prompter), a little early for the network; the web app
// shows it in sync. Only slide changes are written, not the position.
export function usePrompterBroadcast({ setlist, loadedItem, settings, enabled, user, notify }) {
  const data = normalizePrompter(useLoadedPrompter(loadedItem));
  const itemId = loadedItem?.id;
  const lead = (settings.prompterLead || 0) + NETWORK_LEAD;
  const index = useEngineStatus((st) => (enabled && st.songId && st.songId === itemId ? cueIndexAt(data.cues, st.position + lead) : -1));
  const { slide, next } = slidesAtCue(data.cues, index);
  const setlistId = setlist?.id;
  const active = enabled && !!setlistId && !!itemId && data.slides.length > 0;
  const wasActive = useRef(null); // setlist id while publishing

  useEffect(() => {
    if (!active) return;
    wasActive.current = setlistId;
    updateDoc(doc(db, 'setlists', setlistId), liveSlideUpdate(user, 'desktop', itemId, slide, next)).catch((e) =>
      notify(`Gobbo in rete non aggiornato: ${e.message}`, true),
    );
  }, [active, setlistId, itemId, slide, next, user, notify]);

  // Stops leading: the phones stop showing a slide that no longer moves.
  useEffect(() => {
    if (active || !wasActive.current) return;
    const id = wasActive.current;
    wasActive.current = null;
    updateDoc(doc(db, 'setlists', id), { 'live.prompter': null }).catch(() => {});
  }, [active]);
}
