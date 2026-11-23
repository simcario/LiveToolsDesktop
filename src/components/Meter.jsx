import { createContext, useContext, useEffect, useRef } from 'react';
import { subscribeStatus } from '../lib/engine';

// -60 dBFS .. 0 dBFS → 0..1
function level(v) {
  if (!v || v <= 0.001) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(v) + 60) / 60));
}

// Where the levels come from: the engine of this device, or (telecomando) those the computer sends.
export const MeterSource = createContext(subscribeStatus);

/**
 * Peak meter fed directly by the engine status (no React re-render).
 * source: { track: index } (or a list of them: the loudest), { output: index }, { pad: true } or { click: true } (system click, one bar).
 */
export default function Meter({ track, output, pad = false, click = false, horizontal = false }) {
  const l = useRef(null);
  const r = useRef(null);
  const subscribe = useContext(MeterSource);
  const tracks = Array.isArray(track) ? track : track !== undefined && track >= 0 ? [track] : [];
  const tracksKey = tracks.join(',');
  useEffect(() => {
    const shown = [0, 0];
    const written = ['', ''];
    return subscribe((s) => {
      let v = [0, 0];
      tracks.forEach((t) => {
        const m = s.meters[t] || [0, 0];
        v = [Math.max(v[0], m[0]), Math.max(v[1], m[1])];
      });
      if (output !== undefined) v = [s.outputs[output] || 0, s.outputs[output] || 0];
      if (pad) v = [s.pad?.[0] || 0, s.pad?.[1] || 0];
      if (click) v = [s.click || 0, s.click || 0];
      [l, r].forEach((ref, i) => {
        shown[i] = Math.max(level(v[i]), shown[i] * 0.82);
        if (shown[i] < 0.002) shown[i] = 0;
        // A transform, not width/height: no layout. Written only when it changes.
        const value = `${horizontal ? 'scaleX' : 'scaleY'}(${shown[i].toFixed(3)})`;
        if (ref.current && value !== written[i]) {
          written[i] = value;
          ref.current.style.transform = value;
        }
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracksKey, output, pad, click, horizontal, subscribe]);
  return (
    <span className={`meter ${horizontal ? 'h' : ''}`} aria-hidden="true">
      <i>
        <span ref={l} />
      </i>
      {output === undefined && !click && (
        <i>
          <span ref={r} />
        </i>
      )}
    </span>
  );
}
