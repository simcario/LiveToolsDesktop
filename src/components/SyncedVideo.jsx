import { useEffect, useRef } from 'react';
import { engineStatus, livePosition } from '../lib/engine';

// A <video> slaved to the audio engine clock: follows play/stop/locate and
// corrects drift. The audio engine is the master; the video never drives it.
export default function SyncedVideo({ src, offset = 0 }) {
  const ref = useRef(null);
  useEffect(() => {
    let raf;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const v = ref.current;
      if (!v || !src || v.readyState < 1) return;
      const s = engineStatus();
      const target = livePosition() - offset;
      const end = Number.isFinite(v.duration) ? v.duration : Infinity;
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
  }, [src, offset]);
  return <video ref={ref} src={src || undefined} muted playsInline preload="auto" />;
}
