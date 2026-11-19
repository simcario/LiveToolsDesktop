import { useRef } from 'react';

// Console fader of the mixers (Palco, Mixer): striped cap, dB scale beside the slot.
// Shared with LiveTools Mobile (mobile/scripts/sync-desktop.mjs copies this file).
// Faders: the keyboard stays on the transport after each touch (Space on a focused input would do nothing).
// Console scale: ticks every few dB, labels as on a mixing desk (-60 dB is silence).
const FADER_TICKS = [6, 0, -5, -10, -15, -20, -30, -40, -50, -60];
const FADER_LABELS = {
  6: '+6',
  0: '0',
  '-10': '10',
  '-20': '20',
  '-30': '30',
  '-40': '40',
  '-50': '50',
  '-60': '∞',
};

const MIN = -60;
const MAX = 6;
const STEP = 0.5;
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// On a touch screen the input does not take the touches (stage.css): a tap, or a swipe on the
// slot to scroll the mixer, moved the fader there. Only the grip over the cap (.fader-grip,
// touch-action none) moves it, by as much as the finger moves (no jump); two taps = onReset.
function useTouchCap(value, onChange, onReset) {
  const live = useRef({ value, onChange, onReset });
  live.current = { value, onChange, onReset };
  const lastTap = useRef(0);
  return (e) => {
    if (e.pointerType === 'mouse' || !coarse()) return;
    const el = e.currentTarget;
    const input = el.parentElement?.querySelector('input.fader');
    if (!input) return;
    e.preventDefault();
    const r = input.getBoundingClientRect();
    const capH = parseFloat(getComputedStyle(input).getPropertyValue('--cap-h')) || 34;
    const travel = Math.max(1, r.height - capH);
    const start = live.current.value;
    const now = performance.now();
    if (now - lastTap.current < 350) {
      lastTap.current = 0;
      live.current.onReset?.();
      return;
    }
    lastTap.current = now;
    const id = e.pointerId;
    const y0 = e.clientY;
    el.setPointerCapture?.(id);
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      const v = Math.round((start - ((ev.clientY - y0) / travel) * (MAX - MIN)) / STEP) * STEP;
      const next = Math.min(MAX, Math.max(MIN, v));
      if (next !== live.current.value) live.current.onChange(next);
    };
    const end = (ev) => {
      if (ev.pointerId !== id) return;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
}

// midi: id for MIDI learn (lib/midiLearn.js), a CC moves the fader from -60 to +6 dB.
export default function Fader({ value, onChange, onReset, title, light = false, scale = true, midi, midiName }) {
  const onTouch = useTouchCap(value, onChange, onReset);
  return (
    <span className={`fader-wrap ${scale ? 'has-scale' : ''}`} data-midi={midi} data-midi-name={midiName}>
      <span className="fader-scale" aria-hidden="true">
        {FADER_TICKS.map((db) => (
          <i key={db} className={db === 0 ? 'is-zero' : undefined} style={{ '--p': (db + 60) / 66 }} data-l={scale ? FADER_LABELS[db] : undefined} />
        ))}
      </span>
      <input
        className={`fader ${light ? 'is-light' : ''}`}
        type="range"
        min={MIN}
        max={MAX}
        step={STEP}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={onReset}
        onPointerUp={(e) => e.currentTarget.blur()}
        title={title}
        aria-label={title}
      />
      <span className="fader-grip" aria-hidden="true" style={{ '--p': (value - MIN) / (MAX - MIN) }} onPointerDown={onTouch} />
    </span>
  );
}
