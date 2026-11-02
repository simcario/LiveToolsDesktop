// NDI® outputs (src-tauri/src/ndi): the video of the song and the Gobbo as
// sources on the network, also with the output windows closed. The video is
// decoded on the Rust side; the Gobbo picture is drawn here, like the output
// window, only when the slide changes.
import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { engineStatus, subscribeStatus } from './engine';
import { outputCueIndex, outputSlides } from './cues';

export const NDI_KINDS = { video: 'Video', prompter: 'Gobbo' };

// NDI shows the computer name before the source ("PC (LiveTools - Video)"): it is not repeated here.
export const defaultNdiName = (kind) => `LiveTools - ${NDI_KINDS[kind]}`;
export const ndiName = (settings, kind) => settings.ndi[kind].name.trim() || defaultNdiName(kind);

// ---------- Status (outputs on, errors) ----------

let status = { error: null, video: false, prompter: false };
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
  const out = (kind) => ({ enabled: !!settings.ndi[kind].enabled, name: ndiName(settings, kind) });
  const config = JSON.stringify({ video: out('video'), prompter: out('prompter') });
  useEffect(() => {
    invoke('ndi_configure', { config: JSON.parse(config) })
      .then(setStatus)
      .catch(() => {});
  }, [config]);
}

/** The video of the song loaded (the local file), see usePlayer. */
export function setNdiVideoSource(video) {
  const source = video?.local ? { path: video.local, offset: video.offset || 0 } : null;
  invoke('ndi_video_source', { source }).catch(() => {});
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
  const lines = text.split('\n');
  const longest = Math.max(8, ...lines.map((l) => l.length));
  const size = Math.max(10, Math.min(max, (box.h * 0.86) / (lines.length * 1.25), (box.w * 0.94) / (longest * 0.52)));
  const line = size * 1.25;
  const cx = box.x + pad.l + (box.w - pad.l - pad.r) / 2;
  const cy = box.y + pad.t + (box.h - pad.t - pad.b) / 2;
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, cx, cy + (i - (lines.length - 1) / 2) * line));
}

function drawSlides(ctx, current, next) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const nextH = next ? 18 * VH : 0;
  drawText(ctx, current?.text, { x: 0, y: 0, w: W, h: H - nextH }, { t: 4 * VH, b: 4 * VH, l: 4 * VW, r: 4 * VW }, 160, '#fff');
  if (!next) return;
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(0, H - nextH, W, 1);
  drawText(ctx, next.text, { x: 0, y: H - nextH, w: W, h: nextH }, { t: 0, b: 3 * VH, l: 6 * VW, r: 6 * VW }, 48, '#6b7280');
}

/** Sends the Gobbo picture of `source` (see usePrompterOutput) while the NDI output is on. */
export function useNdiPrompter(source, enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let shown = null; // what the last picture has
    let sending = false;
    let alive = true;

    const update = () => {
      if (!alive || sending) return;
      const { current, next } = outputSlides(source, outputCueIndex(source, engineStatus()));
      const key = JSON.stringify([current?.text || '', next?.text ?? null]);
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
  }, [source, enabled]);
}
