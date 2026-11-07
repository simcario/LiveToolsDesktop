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

export default function Fader({ value, onChange, onReset, title, light = false, scale = true }) {
  return (
    <span className={`fader-wrap ${scale ? 'has-scale' : ''}`}>
      <span className="fader-scale" aria-hidden="true">
        {FADER_TICKS.map((db) => (
          <i key={db} className={db === 0 ? 'is-zero' : undefined} style={{ '--p': (db + 60) / 66 }} data-l={scale ? FADER_LABELS[db] : undefined} />
        ))}
      </span>
      <input
        className={`fader ${light ? 'is-light' : ''}`}
        type="range"
        min={-60}
        max={6}
        step={0.5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={onReset}
        onPointerUp={(e) => e.currentTarget.blur()}
        title={title}
        aria-label={title}
      />
    </span>
  );
}
