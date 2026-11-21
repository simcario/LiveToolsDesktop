// NDI® outputs (src-tauri/src/ndi): the video of the song and the Gobbo as
// sources on the network, also with the output windows closed. The video is
// decoded on the Rust side; the Gobbo picture is drawn here, like the output
// window, only when the slide changes.
import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { engineStatus, subscribeStatus } from './engine';
import { outputCueIndex, outputSlides } from './cues';
import { slideLines, slideTags, tagInk } from '../shared/prompter.js';

export const NDI_KINDS = { video: 'Video', prompter: 'Gobbo' };

// NDI shows the computer name before the source ("PC (LiveTools - Video)"): it is not repeated here.
export const defaultNdiName = (kind) => `LiveTools - ${NDI_KINDS[kind]}`;
export const ndiName = (settings, kind) => settings.ndi[kind].name.trim() || defaultNdiName(kind);
// Milliseconds the network and the receiver (vMix, OBS…) keep the picture: it is sent that much ahead.
export const NDI_MAX_LATENCY = 500;
export const ndiLatency = (settings, kind) => Math.max(0, Math.min(NDI_MAX_LATENCY, Number(settings.ndi[kind].latency) || 0));

// ---------- Status (outputs on, errors) ----------

let status = { error: null, video_error: null, prompter_error: null, video: false, prompter: false };
const listeners = new Set();
const setStatus = (s) => {
  status = s;
  listeners.forEach((f) => f());
};
invoke('ndi_status')
  .then(setStatus)
  .catch(() => {}); // no NDI on this build (mobile)

export function useNdiStatus() {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => status,
  );
}

/** Turns the outputs on and off (and renames them) as the settings say. */
export function useNdiOutputs(settings) {
  const out = (kind) => ({ enabled: !!settings.ndi[kind].enabled, name: ndiName(settings, kind), latency: ndiLatency(settings, kind) });
  const config = JSON.stringify({ video: out('video'), prompter: out('prompter') });
  useEffect(() => {
    let timer = 0;
    let alive = true;
    // An output that did not start (name taken by another copy of LiveTools) is tried again every 3 s.
    const configure = () =>
      invoke('ndi_configure', { config: JSON.parse(config) })
        .then((s) => {
          setStatus(s);
          if (alive && (s.video_error || s.prompter_error)) timer = setTimeout(configure, 3000);
        })
        .catch(() => {});
    configure();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [config]);
}

/** The video of the song loaded (the local file), see usePlayer. */
export function setNdiVideoSource(video) {
  // Video item: fades from and to black, as the video window.
  const source = video?.local ? { path: video.local, offset: video.offset || 0, fadeIn: video.fades?.in || 0, fadeOut: video.fades?.out || 0, end: video.fades?.end || 0 } : null;
  invoke('ndi_video_source', { source }).catch(() => {});
}

// Picture of the setlist on the NDI video output when there is no video: drawn
// 1920×1080 on black (whole, centred) and sent once; null = black.
let stillRun = 0;
export async function setNdiStill(src) {
  const run = ++stillRun;
  const send = (bytes) => invoke('ndi_video_still', bytes).catch(() => {});
  if (!src) return send(new Uint8Array(0));
  try {
    const img = new Image();
    // The local file comes from the asset protocol: without CORS the canvas could not be read.
    img.crossOrigin = 'anonymous';
    img.src = src;
    await img.decode();
    if (run !== stillRun) return undefined;
    const canvas = new OffscreenCanvas(1920, 1080);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 1920, 1080);
    const k = Math.min(1920 / img.naturalWidth, 1080 / img.naturalHeight);
    const w = img.naturalWidth * k;
    const h = img.naturalHeight * k;
    ctx.drawImage(img, (1920 - w) / 2, (1080 - h) / 2, w, h);
    return send(new Uint8Array(ctx.getImageData(0, 0, 1920, 1080).data.buffer));
  } catch {
    return run === stillRun ? send(new Uint8Array(0)) : undefined;
  }
}

// ---------- Gobbo picture ----------

const W = 1920;
const H = 1080;
const VH = H / 100;
const VW = W / 100;
const FONT = "Inter, system-ui, 'Segoe UI', sans-serif";

// Same rules as SlideText and the .pw-current / .pw-next styles of the window.
function drawText(ctx, text, box, pad, max, color) {
  if (!text) return;
  // Runs of coloured or highlighted words ([rosa]…[/], [evid rosa]…[/]), as SlideText.
  const lines = slideLines(text);
  const longest = Math.max(8, ...lines.map((l) => l.reduce((n, r) => n + r.text.length, 0)));
  const size = Math.max(10, Math.min(max, (box.h * 0.86) / (lines.length * 1.25), (box.w * 0.94) / (longest * 0.52)));
  const line = size * 1.25;
  const cx = box.x + pad.l + (box.w - pad.l - pad.r) / 2;
  const cy = box.y + pad.t + (box.h - pad.t - pad.b) / 2;
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const padMark = size * 0.12;
  lines.forEach((runs, i) => {
    const y = cy + (i - (lines.length - 1) / 2) * line;
    const widths = runs.map((r) => ctx.measureText(r.text).width + (r.mark ? padMark * 2 : 0));
    let x = cx - widths.reduce((a, b) => a + b, 0) / 2;
    runs.forEach((r, k) => {
      if (r.mark) {
        ctx.fillStyle = r.color;
        ctx.beginPath();
        ctx.roundRect(x, y - line / 2, widths[k], line, padMark);
        ctx.fill();
        ctx.fillStyle = tagInk(r.color);
        ctx.fillText(r.text, x + padMark, y);
      } else {
        ctx.fillStyle = r.color || color;
        ctx.fillText(r.text, x, y);
      }
      x += widths[k];
    });
  });
}

// The directions of a slide (SlideTags, .pw-tags): centred pills from `y`; returns the height used.
function drawTags(ctx, slide, y, size, alpha = 1) {
  const tags = slideTags(slide);
  if (!tags.length) return 0;
  ctx.font = `800 ${size}px ${FONT}`;
  const padX = size * 0.75;
  const gap = size * 0.5;
  const h = size * 1.54;
  const widths = tags.map((t) => ctx.measureText(t.label).width + padX * 2);
  let x = (W - widths.reduce((a, b) => a + b, 0) - gap * (tags.length - 1)) / 2;
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  tags.forEach((t, i) => {
    ctx.fillStyle = t.color;
    ctx.beginPath();
    ctx.roundRect(x, y, widths[i], h, h / 2);
    ctx.fill();
    ctx.fillStyle = tagInk(t.color);
    ctx.fillText(t.label, x + widths[i] / 2, y + h / 2);
    x += widths[i] + gap;
  });
  ctx.globalAlpha = 1;
  return h;
}

function drawSlides(ctx, current, next) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const nextTags = next && slideTags(next).length ? 1.2 * VH + 2.4 * VH * 1.54 : 0;
  const nextH = next ? 18 * VH + nextTags : 0;
  const top = drawTags(ctx, current, 3 * VH, 4.2 * VH);
  const used = top ? 3 * VH + top : 0;
  drawText(ctx, current?.text, { x: 0, y: used, w: W, h: H - nextH - used }, { t: 4 * VH, b: 4 * VH, l: 4 * VW, r: 4 * VW }, 160, '#fff');
  if (!next) return;
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(0, H - nextH, W, 1);
  drawTags(ctx, next, H - nextH + 1.2 * VH, 2.4 * VH, 0.75);
  drawText(ctx, next.text, { x: 0, y: H - nextH + nextTags, w: W, h: nextH - nextTags }, { t: 0, b: 3 * VH, l: 6 * VW, r: 6 * VW }, 48, '#6b7280');
}

/**
 * Sends the Gobbo picture of `source` (see usePrompterOutput) while the NDI output is on,
 * `latency` ms ahead of the audio so the slide changes on time on the receiver.
 */
export function useNdiPrompter(source, enabled, latency = 0) {
  useEffect(() => {
    if (!enabled) return undefined;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let shown = null; // what the last picture has
    let sending = false;
    let alive = true;

    const update = () => {
      if (!alive || sending) return;
      const s = engineStatus();
      const { current, next } = outputSlides(source, outputCueIndex(source, latency ? { ...s, position: s.position + latency / 1000 } : s));
      const key = JSON.stringify([current?.text || '', slideTags(current), next?.text ?? null, next ? slideTags(next) : null]);
      if (key === shown) return;
      shown = key;
      drawSlides(ctx, current, next);
      sending = true;
      invoke('ndi_prompter_frame', new Uint8Array(ctx.getImageData(0, 0, W, H).data.buffer))
        .catch(() => {})
        .finally(() => {
          sending = false;
          update(); // the slide may have changed meanwhile
        });
    };

    const unsubscribe = subscribeStatus(update);
    document.fonts.load(`700 48px ${FONT}`).finally(update);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [source, enabled, latency]);
}
