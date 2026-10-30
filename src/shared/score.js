// PDF score of a song (spartito) and the page turner: a Bluetooth pedal pairs
// as a keyboard and sends a key per press (PageDown/PageUp, arrows, Space…),
// mapped here to "next page" / "previous page". Shared by the web app and the
// desktop app (desktop/src/shared/score.js, see sync-shared).
//
// song.score = { id, name, file, path, size, type } | null, stored with the
// other media of the song (see media.js).

import { useCallback, useEffect, useRef, useState } from 'react';

export const scoreOf = (song) =>(song?.score?.path ? song.score : null);

export const isPdfFile = (file) => file?.type === 'application/pdf' || /\.pdf$/i.test(file?.name || '');

// ---------- Pedal ----------

// Keys sent by the common page turners (AirTurn, PageFlip, Donner, iRig
// BlueTurn…) in their default modes. Space and Enter are left out: they start
// the song on the desktop; a pedal sending them can be taught in "Impara".
export const DEFAULT_PEDAL = {
  next: ['PageDown', 'ArrowRight', 'ArrowDown'],
  prev: ['PageUp', 'ArrowLeft', 'ArrowUp'],
  layout: 'auto', // auto (two pages on a wide screen), single, double
};

export const PEDAL_LAYOUTS = [
  ['auto', 'Automatico'],
  ['single', 'Una pagina'],
  ['double', 'Due pagine affiancate'],
];

export function pedalOf(saved) {
  const p = { ...DEFAULT_PEDAL, ...(saved || {}) };
  return {
    next: Array.isArray(p.next) ? p.next : DEFAULT_PEDAL.next,
    prev: Array.isArray(p.prev) ? p.prev : DEFAULT_PEDAL.prev,
    layout: PEDAL_LAYOUTS.some(([k]) => k === p.layout) ? p.layout : 'auto',
  };
}

/** Name of the key of a keyboard event, as stored in the pedal mapping. */
export const keyOf = (e) => (e.key === ' ' ? 'Space' : e.key?.length === 1 ? e.key.toUpperCase() : e.key);

const KEY_LABELS = {
  PageDown: 'Pag ↓',
  PageUp: 'Pag ↑',
  ArrowRight: '→',
  ArrowLeft: '←',
  ArrowDown: '↓',
  ArrowUp: '↑',
  Space: 'Spazio',
  Enter: 'Invio',
  MediaTrackNext: 'Traccia ▶▶',
  MediaTrackPrevious: 'Traccia ◀◀',
  MediaPlayPause: 'Play/Pausa',
  AudioVolumeUp: 'Volume +',
  AudioVolumeDown: 'Volume −',
};
export const keyLabel = (k) => KEY_LABELS[k] || k;

/** 'next' | 'prev' | null for a key event. Keys with modifiers are never the pedal. */
export function pedalAction(e, pedal) {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = keyOf(e);
  if (pedal.next.includes(k)) return 'next';
  if (pedal.prev.includes(k)) return 'prev';
  return null;
}

/** The pedal mapping after teaching `key` to `action` (it leaves the other one). */
export function teachPedal(pedal, action, key) {
  const other = action === 'next' ? 'prev' : 'next';
  return {
    ...pedal,
    [action]: [key, ...pedal[action].filter((k) => k !== key)],
    [other]: pedal[other].filter((k) => k !== key),
  };
}

// ---------- Pages ----------

/** Pages shown together starting at `page` (1-based). */
export const spreadOf = (page, count, double) => (double && page < count ? [page, page + 1] : [page]);

/** First page after turning: two at a time in the two-page view. */
export function turn(page, count, double, dir) {
  const step = double ? 2 : 1;
  // Spreads start at the odd pages: 1-2, 3-4, 5.
  const last = double ? count - ((count - 1) % 2) : count;
  return Math.min(Math.max(1, page + dir * step), Math.max(1, last));
}

// ---------- PDF (pdf.js) ----------

let pdfjs = null;

/** Loads pdf.js on demand (it is large and only needed for scores). */
async function lib(workerSrc) {
  if (!pdfjs) {
    pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  }
  return pdfjs;
}

/** Opens a PDF from its bytes (ArrayBuffer / Uint8Array). Returns the pdf.js document. */
export async function openPdf(data, workerSrc) {
  const { getDocument } = await lib(workerSrc);
  return getDocument({ data: data instanceof Uint8Array ? data : new Uint8Array(data) }).promise;
}

/**
 * Renders page `n` into a new canvas fitting width × height (CSS pixels),
 * sharp on high-density screens.
 */
export async function renderPage(pdf, n, width, height) {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const fit = Math.min(width / base.width, height / base.height);
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  const viewport = page.getViewport({ scale: fit * dpr });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
  page.cleanup();
  return canvas;
}

// ---------- Viewer ----------

const GAP = 12; // px between the two pages of a spread
const CACHE = 8; // rendered pages kept (current spread and the ones around it)

/**
 * State of a score viewer. `load()` resolves with the PDF bytes (it changes
 * with the song); `boxRef` is the element the pages fit into. While `active`,
 * the pedal keys turn the pages and no one else receives them (on the desktop
 * the same arrows change song).
 *
 * Returns { status: 'loading' | 'ready' | 'error', error, page, count,
 * double, spread: [canvas…], go(dir), goto(n), lastPedal: { key, action, at } }.
 */
export function useScoreViewer({ load, loadKey, workerSrc, pedal, active = true, boxRef }) {
  const [doc, setDoc] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(null);
  const [spread, setSpread] = useState([]);
  const [lastPedal, setLastPedal] = useState(null);
  const cache = useRef(new Map());

  // The document, again for every song.
  useEffect(() => {
    let cancelled = false;
    let opened = null;
    setDoc(null);
    setSpread([]);
    setPage(1);
    setError(null);
    setStatus('loading');
    cache.current = new Map();
    (async () => {
      try {
        const bytes = await load();
        if (cancelled) return;
        opened = await openPdf(bytes, workerSrc);
        if (cancelled) return opened.destroy();
        setDoc(opened);
        setStatus('ready');
      } catch (e) {
        if (!cancelled) {
          setError(String(e?.message || e));
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      opened?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  // Size of the box the pages fit into.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [boxRef, status]);

  const count = doc?.numPages || 0;
  const double = !!size && count > 1 && (pedal.layout === 'double' || (pedal.layout === 'auto' && size.w > size.h * 1.25));

  // Rendered pages: the current spread first, then the next and previous ones
  // in the background, so a pedal press shows the new page at once.
  useEffect(() => {
    if (!doc || !size?.w || !size?.h) return undefined;
    let cancelled = false;
    const w = double ? (size.w - GAP) / 2 : size.w;
    const keyOfPage = (n) => `${n}@${Math.round(w)}x${Math.round(size.h)}`;
    const get = (n) => {
      const k = keyOfPage(n);
      if (!cache.current.has(k)) cache.current.set(k, renderPage(doc, n, w, size.h));
      return cache.current.get(k);
    };
    const pages = spreadOf(Math.min(page, count), count, double);
    Promise.all(pages.map(get))
      .then((canvases) => {
        if (cancelled) return;
        setSpread(canvases);
        const around = [turn(page, count, double, 1), turn(page, count, double, -1)].flatMap((p) => spreadOf(p, count, double));
        around.forEach((n) => get(n).catch(() => {}));
        // Keep only the latest pages.
        const keep = new Set([...pages, ...around].map(keyOfPage));
        for (const k of [...cache.current.keys()]) if (!keep.has(k) && cache.current.size > CACHE) cache.current.delete(k);
      })
      .catch((e) => !cancelled && setError(String(e?.message || e)));
    return () => {
      cancelled = true;
    };
  }, [doc, size, page, count, double]);

  const go = useCallback((dir) => setPage((p) => (count ? turn(p, count, double, dir) : p)), [count, double]);
  const goto = useCallback((n) => setPage(() => Math.min(Math.max(1, n), Math.max(1, count))), [count]);

  // Pedal: captured before every other key handler of the page.
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.target.closest?.('input, select, textarea, [contenteditable="true"]')) return;
      const action = pedalAction(e, pedal);
      if (!action) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setLastPedal({ key: keyOf(e), action, at: Date.now() });
      go(action === 'next' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, pedal, go]);

  return { status, error, page: Math.min(page, Math.max(1, count)), count, double, spread, go, goto, lastPedal };
}

/**
 * Last key received while `active` (Preferences: to see that the pedal is
 * connected and what it sends). With `learn` = 'next' | 'prev' the key is
 * handed to onLearn instead and swallowed.
 */
export function usePedalTest({ active = true, pedal, learn = null, onLearn }) {
  const [last, setLast] = useState(null);
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.repeat || ['Shift', 'Control', 'Alt', 'Meta', 'Escape', 'Tab'].includes(e.key)) return;
      const key = keyOf(e);
      if (learn) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onLearn?.(learn, key);
      }
      setLast({ key, action: learn || pedalAction(e, pedal), at: Date.now() });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, pedal, learn, onLearn]);
  return last;
}
