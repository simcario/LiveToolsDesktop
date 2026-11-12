// Frames of a video as small pictures (Transizioni page, Video lane): at times rounded by
// the caller, taken one at a time by a hidden <video> per file, kept in memory. The last
// asked come first (the ones in sight while scrolling).
const H = 54;
const MAX_THUMBS = 800;
const MAX_QUEUE = 160;
const MAX_FILES = 6;

const cache = new Map(); // `${src}|${t}` → canvas | 'pending' | 'none'
const queue = [];
const files = new Map(); // src → Promise<HTMLVideoElement | null>
const listeners = new Set();
let busy = false;
let notifyRaf = 0;

/** Called (once per frame at most) when new pictures are ready. */
export function onThumbs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  if (notifyRaf) return;
  notifyRaf = requestAnimationFrame(() => {
    notifyRaf = 0;
    listeners.forEach((fn) => fn());
  });
}

/** The picture of `src` at `t` seconds (null while it is being taken, or when it can't be). */
export function thumbAt(src, t) {
  const key = `${src}|${t.toFixed(2)}`;
  const v = cache.get(key);
  if (v === 'none' || v === 'pending') return null;
  if (v) return v;
  cache.set(key, 'pending');
  queue.push({ src, t, key });
  // Too many asked (a fast scroll): the oldest are forgotten, asked again if still in sight.
  while (queue.length > MAX_QUEUE) cache.delete(queue.shift().key);
  pump();
  return null;
}

/** Ratio width / height of a video already opened (16:9 until then). */
export function thumbRatio(src) {
  return ratios.get(src) || 16 / 9;
}
const ratios = new Map();

function videoFor(src) {
  let p = files.get(src);
  if (p) return p;
  p = new Promise((resolve) => {
    const el = document.createElement('video');
    el.muted = true;
    el.preload = 'auto';
    el.playsInline = true;
    const timer = setTimeout(() => resolve(null), 15000);
    el.onloadeddata = () => {
      clearTimeout(timer);
      if (el.videoWidth && el.videoHeight) ratios.set(src, el.videoWidth / el.videoHeight);
      resolve(el);
    };
    el.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    el.src = src;
  });
  files.set(src, p);
  if (files.size > MAX_FILES) {
    const [old, op] = files.entries().next().value;
    files.delete(old);
    op.then((el) => {
      if (!el) return;
      el.removeAttribute('src');
      el.load();
    });
  }
  return p;
}

function grab(el, t) {
  return new Promise((resolve) => {
    const at = Math.max(0, Math.min((Number.isFinite(el.duration) ? el.duration : t) - 0.05, t));
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      el.removeEventListener('seeked', done);
      if (!el.videoWidth) return resolve(null);
      const c = document.createElement('canvas');
      c.height = H;
      c.width = Math.round((H * el.videoWidth) / el.videoHeight);
      c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
      resolve(c);
    };
    el.addEventListener('seeked', done);
    timer = setTimeout(done, 3000);
    el.currentTime = at;
  });
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.pop();
      if (cache.get(job.key) !== 'pending') continue;
      let img = null;
      try {
        const el = await videoFor(job.src);
        img = el ? await grab(el, job.t) : null;
      } catch {
        img = null;
      }
      cache.set(job.key, img || 'none');
      while (cache.size > MAX_THUMBS) cache.delete(cache.keys().next().value);
      if (img) notify();
    }
  } finally {
    busy = false;
  }
}
