// MP3 encoding of PCM samples (used by mp3.js and mp3.worker.js): LAME (lamejs)
// at 320 kbps CBR, preceded by an "Info" frame with a LAME tag that gives the
// encoder delay and the padding, so gapless players (the Rust engine with
// enable_gapless, Chrome, ffmpeg) return exactly the samples of the original.
// Plain JS, also runs in Node. Shared with the desktop and the tablet app.
import { Mp3Encoder } from '@breezystack/lamejs';

export const MP3_KBPS = 320;
// Delay of the LAME encoder (samples before the first one of the input), as LAME writes it in its tag.
const ENC_DELAY = 576;

// CRC-16 of the LAME tag (polynomial 0x8005, reflected, start 0).
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc16(bytes, crc = 0) {
  for (let i = 0; i < bytes.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  return crc;
}

const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const RATES = [44100, 48000, 32000];

// MPEG-1 Layer III frame header at `p`, or null.
function frameAt(b, p) {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1] & 0xfe) !== 0xfa) return null;
  const kbps = BITRATES[b[p + 2] >> 4];
  const rate = RATES[(b[p + 2] >> 2) & 3];
  if (!kbps || !rate) return null;
  const mono = b[p + 3] >> 6 === 3;
  return { length: Math.floor((144000 * kbps) / rate) + ((b[p + 2] >> 1) & 1), sideInfo: mono ? 17 : 32 };
}

/**
 * The "Info" frame (Xing tag for CBR files + LAME tag) that goes before the
 * `frames` audio frames: same header as the first of them, with the sample count
 * given as encoder delay and padding.
 */
function infoFrame(first, frames, samples, audioBytes, audioCrc) {
  const head = frameAt(first, 0);
  const b = new Uint8Array(head.length - ((first[2] >> 1) & 1)); // no padding byte
  b.set(first.subarray(0, 4));
  b[2] &= ~0x02;
  b[1] |= 0x01; // no CRC
  const v = new DataView(b.buffer);
  let p = 4 + head.sideInfo;
  b.set([73, 110, 102, 111], p); // "Info"
  v.setUint32(p + 4, 0x0f); // frames, bytes, TOC, quality
  v.setUint32(p + 8, frames); // audio frames, this one excluded
  v.setUint32(p + 12, audioBytes + b.length);
  for (let i = 0; i < 100; i += 1) b[p + 16 + i] = Math.floor((i * 256) / 100);
  v.setUint32(p + 116, 0);
  p += 120;
  b.set([...'LAME3.98r'].map((c) => c.charCodeAt(0)), p);
  b[p + 9] = 0x01; // tag revision 0, CBR
  b[p + 10] = 200; // lowpass 20 kHz
  b[p + 20] = 255; // bitrate (≥ 255 kbps)
  const padding = frames * 1152 - ENC_DELAY - samples;
  if (padding < 0 || padding > 4095) throw new Error(`Riempimento MP3 inatteso (${padding} campioni).`);
  b[p + 21] = ENC_DELAY >> 4;
  b[p + 22] = ((ENC_DELAY & 0x0f) << 4) | (padding >> 8);
  b[p + 23] = padding & 0xff;
  v.setUint32(p + 28, audioBytes + b.length); // music length
  v.setUint16(p + 32, audioCrc);
  v.setUint16(p + 34, crc16(b.subarray(0, p + 34)));
  return b;
}

const toInt16 = (f, from, n) => {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    // TPDF dither (±1 LSB) on the way to 16 bits.
    const s = f[from + i] * 32767 + (Math.random() - Math.random());
    out[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
  }
  return out;
};

/**
 * { sampleRate, channels: Float32Array[] } (1 or 2 channels; more are mixed to
 * stereo) → MP3 bytes. onProgress(0..1).
 */
export function encodePcm(pcm, { kbps = MP3_KBPS, onProgress } = {}) {
  let { channels } = pcm;
  if (channels.length > 2) {
    // Odd channels left, even right.
    const n = channels[0].length;
    const mix = [new Float32Array(n), new Float32Array(n)];
    const k = 1 / Math.ceil(channels.length / 2);
    channels.forEach((ch, c) => {
      const m = mix[c % 2];
      for (let i = 0; i < n; i += 1) m[i] += ch[i] * k;
    });
    channels = mix;
  }
  const samples = channels[0].length;
  const encoder = new Mp3Encoder(channels.length, pcm.sampleRate, kbps);
  const parts = [];
  const STEP = 1152 * 64;
  for (let i = 0; i < samples; i += STEP) {
    const n = Math.min(STEP, samples - i);
    const l = toInt16(channels[0], i, n);
    const out = channels.length === 2 ? encoder.encodeBuffer(l, toInt16(channels[1], i, n)) : encoder.encodeBuffer(l);
    if (out.length) parts.push(out.slice());
    onProgress?.(i / samples);
  }
  parts.push(encoder.flush().slice());

  const audio = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
  let at = 0;
  parts.forEach((x) => {
    audio.set(x, at);
    at += x.length;
  });
  // Audio frames, after a tag the encoder may have written.
  let start = 0;
  while (start < audio.length && !frameAt(audio, start)) start += 1;
  let frames = 0;
  for (let p = start; p < audio.length; ) {
    const f = frameAt(audio, p);
    if (!f) break;
    frames += 1;
    p += f.length;
  }
  if (!frames) throw new Error('Conversione in MP3 non riuscita.');
  const body = audio.subarray(start);
  const info = infoFrame(body, frames, samples, body.length, crc16(body));
  const out = new Uint8Array(info.length + body.length);
  out.set(info);
  out.set(body, info.length);
  onProgress?.(1);
  return out;
}

