// MP3 conversion of the uncompressed audio files before they go to the cloud (Pro:
// only MP3) or, by choice, to the user's Google Drive (Plus). The original stays
// where it was on the device. LAME (lamejs) at 320 kbps CBR, with an "Info" frame
// and a LAME tag at the start that give the encoder delay and the padding: players
// that know it (the Rust engine with enable_gapless, Chrome, ffmpeg) play exactly
// the samples of the original, so the stems stay in sync with each other and with
// the click. Shared with the desktop and the tablet app (scripts/sync-shared.mjs).
//
// Runs in a worker when it can (mp3.worker.js); the encoding itself is in
// mp3encode.js, plain JS that also runs in Node (tests).
import { encodePcm } from './mp3encode';

export const mp3Name = (name) => `${(name || 'traccia').replace(/\.[a-z0-9]+$/i, '')}.mp3`;

const MPEG1_RATES = [44100, 48000, 32000];

// ---------- Reading the PCM ----------

const ascii = (v, at, n) => String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset + at, n));

// 80-bit IEEE extended (AIFF sample rate).
function extended(v, at) {
  const exp = v.getUint16(at) & 0x7fff;
  const hi = v.getUint32(at + 2);
  const lo = v.getUint32(at + 6);
  return Math.round((hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63));
}

// Samples of one interleaved block as -1..1 floats, per channel.
function deinterleave(v, start, bytes, channels, bits, float, little) {
  const width = bits / 8;
  const frames = Math.floor(bytes / (width * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  let p = start;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      let s;
      if (float) s = bits === 64 ? v.getFloat64(p, little) : v.getFloat32(p, little);
      else if (bits === 8) s = little ? (v.getUint8(p) - 128) / 128 : v.getInt8(p) / 128;
      else if (bits === 16) s = v.getInt16(p, little) / 32768;
      else if (bits === 24) {
        const b0 = v.getUint8(p);
        const b1 = v.getUint8(p + 1);
        const b2 = v.getUint8(p + 2);
        const n = little ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
        s = ((n << 8) >> 8) / 8388608;
      } else s = v.getInt32(p, little) / 2147483648;
      out[c][i] = s;
      p += width;
    }
  }
  return out;
}

/** WAV (PCM, float, extensible) → { sampleRate, channels: Float32Array[] }, or null if not readable here. */
export function readWav(buffer) {
  const v = new DataView(buffer);
  if (v.byteLength < 12 || ascii(v, 0, 4) !== 'RIFF' || ascii(v, 8, 4) !== 'WAVE') return null;
  let fmt = null;
  let p = 12;
  while (p + 8 <= v.byteLength) {
    const id = ascii(v, p, 4);
    let size = v.getUint32(p + 4, true);
    if (id === 'fmt ') {
      let format = v.getUint16(p + 8, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(p + 32, true); // WAVE_FORMAT_EXTENSIBLE: sub-format
      fmt = { format, channels: v.getUint16(p + 10, true), sampleRate: v.getUint32(p + 12, true), bits: v.getUint16(p + 22, true) };
    } else if (id === 'data' && fmt) {
      // Some writers leave 0 or a too big size in a streamed file: up to the end.
      if (!size || p + 8 + size > v.byteLength) size = v.byteLength - p - 8;
      const float = fmt.format === 3;
      if (!(fmt.format === 1 || float) || ![8, 16, 24, 32, 64].includes(fmt.bits) || (float && fmt.bits < 32)) return null;
      return { sampleRate: fmt.sampleRate, channels: deinterleave(v, p + 8, size, fmt.channels, fmt.bits, float, true) };
    }
    p += 8 + size + (size & 1);
  }
  return null;
}

/** AIFF / AIFC (uncompressed) → { sampleRate, channels }, or null. */
export function readAiff(buffer) {
  const v = new DataView(buffer);
  if (v.byteLength < 12 || ascii(v, 0, 4) !== 'FORM' || !['AIFF', 'AIFC'].includes(ascii(v, 8, 4))) return null;
  let comm = null;
  let p = 12;
  while (p + 8 <= v.byteLength) {
    const id = ascii(v, p, 4);
    const size = v.getUint32(p + 4);
    if (id === 'COMM') {
      const compression = size >= 22 ? ascii(v, p + 26, 4) : 'NONE';
      comm = { channels: v.getUint16(p + 8), bits: v.getUint16(p + 14), sampleRate: extended(v, p + 16), compression };
    } else if (id === 'SSND' && comm) {
      const little = comm.compression === 'sowt';
      const float = comm.compression === 'fl32' || comm.compression === 'FL32' || comm.compression === 'fl64';
      if (!['NONE', 'sowt', 'twos', 'fl32', 'FL32', 'fl64'].includes(comm.compression)) return null;
      const offset = v.getUint32(p + 8);
      const start = p + 16 + offset;
      const bytes = Math.min(size - 8 - offset, v.byteLength - start);
      return { sampleRate: comm.sampleRate, channels: deinterleave(v, start, bytes, comm.channels, comm.bits, float, little) };
    }
    p += 8 + size + (size & 1);
  }
  return null;
}

// FLAC sample rate, from STREAMINFO.
function flacRate(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 32));
  if (String.fromCharCode(...b.slice(0, 4)) !== 'fLaC') return null;
  return (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
}

const AudioCtx = () => globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;

async function decodeWithBrowser(buffer, rate) {
  const Ctx = AudioCtx();
  if (!Ctx) throw new Error('Questo dispositivo non sa leggere il file per convertirlo in MP3.');
  const audio = await new Ctx(1, 1, rate).decodeAudioData(buffer.slice(0));
  return { sampleRate: audio.sampleRate, channels: Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c)) };
}

// Rates MP3 (MPEG-1) does not have, e.g. 88.2 or 96 kHz: resampled with the browser.
async function resample(pcm) {
  const to = pcm.sampleRate % 11025 === 0 ? 44100 : 48000;
  const Ctx = AudioCtx();
  if (!Ctx) throw new Error(`Frequenza di campionamento di ${pcm.sampleRate} Hz non convertibile qui: esporta il file a 44,1 o 48 kHz.`);
  const length = Math.ceil((pcm.channels[0].length * to) / pcm.sampleRate);
  const ctx = new Ctx(pcm.channels.length, length, to);
  const src = ctx.createBufferSource();
  const buf = ctx.createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.sampleRate);
  pcm.channels.forEach((ch, c) => buf.copyToChannel(ch, c));
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return { sampleRate: to, channels: Array.from({ length: out.numberOfChannels }, (_, c) => out.getChannelData(c)) };
}

/** The samples of a WAV, AIFF or FLAC file, at a rate MP3 has. Main thread (it may need the browser's decoder). */
export async function decodePcm(file) {
  const buffer = await file.arrayBuffer();
  let pcm = readWav(buffer) || readAiff(buffer);
  if (!pcm) pcm = await decodeWithBrowser(buffer, flacRate(buffer) || 48000);
  if (!pcm.channels.length || !pcm.channels[0].length) throw new Error('Il file non contiene audio.');
  if (!MPEG1_RATES.includes(pcm.sampleRate)) pcm = await resample(pcm);
  return pcm;
}

// ---------- Files ----------

const canceled = () => Object.assign(new Error('Caricamento annullato'), { code: 'storage/canceled' });

// MP3 in a worker; null when this device cannot start one (then on the main thread).
// The samples are transferred only once the worker said it is ready.
function inWorker(pcm, onProgress, signal) {
  return new Promise((resolve, reject) => {
    let worker;
    let sent = false;
    try {
      worker = new Worker(new URL('./mp3.worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(null);
      return;
    }
    const fail = (e) => {
      worker.terminate();
      if (sent) reject(e instanceof Error ? e : new Error('Conversione in MP3 non riuscita.'));
      else resolve(null);
    };
    signal?.addEventListener('abort', () => {
      worker.terminate();
      reject(canceled());
    });
    worker.onmessage = ({ data }) => {
      if (data.ready) {
        sent = true;
        worker.postMessage(pcm, pcm.channels.map((c) => c.buffer));
      } else if (data.progress != null) onProgress?.(data.progress);
      else if (data.error) fail(new Error(data.error));
      else {
        worker.terminate();
        resolve(data.bytes);
      }
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      fail(e.error);
    };
  });
}

// A few conversions at a time: each one holds the whole file in memory.
const SLOTS = Math.max(1, Math.min(4, ((globalThis.navigator?.hardwareConcurrency || 2) >> 1) || 1));
let running = 0;
const waiting = [];
async function slot(fn) {
  if (running >= SLOTS) await new Promise((r) => waiting.push(r));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/**
 * A WAV, AIFF or FLAC file → the same audio as MP3 320 kbps (a File named .mp3).
 * onProgress(0..1) covers the encoding; `signal` (AbortSignal) cancels it.
 */
export function toMp3(file, onProgress, signal) {
  return slot(async () => {
    if (signal?.aborted) throw canceled();
    onProgress?.(0);
    const pcm = await decodePcm(file);
    if (signal?.aborted) throw canceled();
    const bytes = (await inWorker(pcm, onProgress, signal)) || encodePcm(pcm, { onProgress });
    return new File([bytes], mp3Name(file.name), { type: 'audio/mpeg', lastModified: Date.now() });
  });
}
