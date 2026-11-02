import { useEffect, useRef } from 'react';
import { subscribeStatus } from '../lib/engine';

// -60 dBFS .. 0 dBFS → 0..1
function level(v) {
  if (!v || v <= 0.001) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(v) + 60) / 60));
}

/**
 * Peak meter fed directly by the engine status (no React re-render).
 * source: { track: index } (or a list of them: the loudest), or { output: index }.
 */
export default function Meter({ track, output, horizontal = false }) {
  const l = useRef(null);
  const r = useRef(null);
  const tracks = Array.isArray(track) ? track : track !== undefined && track >= 0 ? [track] : [];
  const tracksKey = tracks.join(',');
  useEffect(() => {
    const shown = [0, 0];
    return subscribeStatus((s) => {
      let v = [0, 0];
      tracks.forEach((t) => {
        const m = s.meters[t] || [0, 0];
        v = [Math.max(v[0], m[0]), Math.max(v[1], m[1])];
      });
      if (output !== undefined) v = [s.outputs[output] || 0, s.outputs[output] || 0];
      [l, r].forEach((ref, i) => {
        shown[i] = Math.max(level(v[i]), shown[i] * 0.82);
        if (ref.current) {
          const pct = `${(shown[i] * 100).toFixed(1)}%`;
          if (horizontal) ref.current.style.width = pct;
          else ref.current.style.height = pct;
        }
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracksKey, output, horizontal]);
  return (
    <span className={`meter ${horizontal ? 'h' : ''}`} aria-hidden="true">
      <i>
        <span ref={l} />
      </i>
      {output === undefined && (
        <i>
          <span ref={r} />
        </i>
      )}
    </span>
  );
}
