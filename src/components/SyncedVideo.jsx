import { useEffect, useRef } from 'react';
import { engineStatus, livePosition } from '../lib/engine';
import { fadeLevel, fadeStop } from '../shared/media.js';

const NO_FADES = { in: 0, out: 0, end: null };

// A <video> slaved to the audio engine clock: follows play/stop/locate and
// corrects drift. The audio engine is the master; the video never drives it.
// `fades` (video items): the picture comes from and goes to black; `end` stops it before
// the end of the file (the sound can go on: media.js audioFades).
//
// `tail` (video output window): a video item still on screen after the next song took over
// (overlap, crossfade). The same element plays on by itself to its end, fading out, then
// `onEnd`: no reload of the file, so the picture never blinks when the songs change.
// Stop in the engine ends the tail too.
//
// `song` (item id): the engine is followed only while it plays that song. At the change of
// song the engine is already on the next one (position ≈ 0) a moment before this element
// becomes the tail: without the check it was put back to the start of the video.
export default function SyncedVideo({ src, offset = 0, fades = NO_FADES, tail = null, song = null, onEnd }) {
  const ref = useRef(null);
  const fadeIn = fades?.in || 0;
  const fadeOut = fades?.out || 0;
  const fadeEnd = fades?.end || null;
  const endRef = useRef(onEnd);
  endRef.current = onEnd;

  useEffect(() => {
    if (tail) return undefined;
    let raf;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const v = ref.current;
      if (!v || !src || v.readyState < 1) return;
      const s = engineStatus();
      if (song && s.songId && s.songId !== song) return;
      const target = livePosition() - offset;
      const end = fadeStop({ end: fadeEnd }, Number.isFinite(v.duration) ? v.duration : Infinity);
      if (fadeIn || fadeOut || fadeEnd) v.style.opacity = String(fadeLevel(Math.max(0, target), v.duration, { in: fadeIn, out: fadeOut, end: fadeEnd }));
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
  }, [src, offset, fadeIn, fadeOut, fadeEnd, tail, song]);

  useEffect(() => {
    const v = ref.current;
    if (!tail || !v) return undefined;
    let raf;
    const out = { in: 0, out: tail.fades?.out ?? fadeOut, end: tail.fades?.end ?? fadeEnd };
    const done = () => endRef.current?.();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const end = fadeStop(out, Number.isFinite(v.duration) ? v.duration : Infinity);
      v.style.opacity = String(fadeLevel(v.currentTime, v.duration, out));
      if (v.ended || v.currentTime >= end - 0.03 || !engineStatus().playing) {
        v.pause();
        done();
      }
    };
    // Where the song that left would be now. Already playing (the element of the song that
    // just ended): it goes on, corrected only if it drifted. Otherwise (the window opened
    // mid-transition) it starts there.
    const start = () => {
      const at = Math.max(0, tail.at - (tail.offset ?? offset) + (Date.now() - tail.since) / 1000);
      if (v.paused || Math.abs(v.currentTime - at) > 0.25) v.currentTime = at;
      if (v.paused) v.play().catch(done);
      raf = requestAnimationFrame(tick);
    };
    if (v.readyState >= 1) start();
    else v.addEventListener('loadedmetadata', start, { once: true });
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('loadedmetadata', start);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tail]);

  return (
    <video
      ref={ref}
      className={tail ? 'video-tail' : undefined}
      src={src || undefined}
      muted
      playsInline
      preload="auto"
      // The same with or without tail: a changed style would reset the opacity set by the ticks.
      style={fadeIn ? { opacity: 0 } : undefined}
    />
  );
}
