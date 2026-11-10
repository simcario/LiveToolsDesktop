import { useEffect, useRef } from 'react';
import { engineStatus, livePosition } from '../lib/engine';
import { fadeLevel } from '../shared/media.js';

const NO_FADES = { in: 0, out: 0 };

// A <video> slaved to the audio engine clock: follows play/stop/locate and
// corrects drift. The audio engine is the master; the video never drives it.
// `fades` (video items): the picture comes from and goes to black.
export default function SyncedVideo({ src, offset = 0, fades = NO_FADES }) {
  const ref = useRef(null);
  const fadeIn = fades?.in || 0;
  const fadeOut = fades?.out || 0;
  useEffect(() => {
    let raf;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const v = ref.current;
      if (!v || !src || v.readyState < 1) return;
      const s = engineStatus();
      const target = livePosition() - offset;
      const end = Number.isFinite(v.duration) ? v.duration : Infinity;
      if (fadeIn || fadeOut) v.style.opacity = String(fadeLevel(Math.max(0, target), end, { in: fadeIn, out: fadeOut }));
      // Tempo of the song changed: the video keeps the original times, at the new speed.
      const rate = s.rate || 1;
      if (Math.abs(v.playbackRate - rate) > 1e-3) v.playbackRate = rate;
      if (s.playing && !s.waiting && target >= 0 && target < end) {
        if (v.paused) {
          v.currentTime = target;
          v.play().catch(() => {});
        } else if (Math.abs(v.currentTime - target) > 0.12) {
          v.currentTime = target;
        }
      } else {
        if (!v.paused) v.pause();
        const t = Math.max(0, Math.min(target, end - 0.05));
        if (!v.seeking && Math.abs(v.currentTime - t) > 0.05) v.currentTime = t;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [src, offset, fadeIn, fadeOut]);
  return <video ref={ref} src={src || undefined} muted playsInline preload="auto" style={fadeIn ? { opacity: 0 } : undefined} />;
}

// The video of a video item still on screen after the next song took over
// (overlap, crossfade): it plays on by itself to its end, fading out, and is
// gone. Its sound is the engine's tail.
export function TailVideo({ tail, onEnd }) {
  const ref = useRef(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return undefined;
    let raf;
    const fades = { in: 0, out: tail.fades?.out || 0 };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const end = Number.isFinite(v.duration) ? v.duration : Infinity;
      v.style.opacity = String(fadeLevel(v.currentTime, end, fades));
      if (v.ended || v.currentTime >= end - 0.03) onEnd();
    };
    const start = () => {
      v.currentTime = Math.max(0, tail.at - (tail.offset || 0) + (Date.now() - tail.since) / 1000);
      v.play().catch(() => onEnd());
      raf = requestAnimationFrame(tick);
    };
    if (v.readyState >= 1) start();
    else v.addEventListener('loadedmetadata', start, { once: true });
    return () => cancelAnimationFrame(raf);
  }, [tail, onEnd]);
  return <video ref={ref} className="video-tail" src={tail.src} muted playsInline preload="auto" />;
}
