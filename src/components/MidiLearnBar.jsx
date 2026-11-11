// Bar of the MIDI learn mode (desktop and tablet, mobile/scripts/sync-desktop.mjs copies it):
// what to do, the control chosen and its message, remove, done.
import { describeKey, setLearning, unassign, useMidiLearnState } from '../lib/midiLearn';
import Icon from './Icon';
import '../styles/midilearn.css';

export default function MidiLearnBar({ settings, update }) {
  const { on, selected, name } = useMidiLearnState();
  if (!on) return null;
  const assigned = selected && settings.midi.map[selected];
  const count = Object.keys(settings.midi.map).length;
  return (
    <div className="midi-learn-bar" role="status">
      <span className="mlb-badge">
        <Icon name="music" size={13} /> MIDI learn
      </span>
      <span className="mlb-text">
        {!selected ? (
          'Tocca un controllo illuminato, poi premi un tasto o muovi un fader sul controller.'
        ) : assigned ? (
          <>
            <b>{name}</b> ← {describeKey(assigned.key)}. Premi un altro tasto per cambiarlo.
          </>
        ) : (
          <>
            <b>{name}</b>: premi un tasto o muovi un fader sul controller.
          </>
        )}
      </span>
      {assigned && (
        <button className="btn btn-sm" onClick={() => unassign(update, selected)} title="Togli il comando MIDI da questo controllo (Canc)">
          Rimuovi
        </button>
      )}
      <span className="mlb-count">{count === 1 ? '1 controllo assegnato' : `${count} controlli assegnati`}</span>
      <button className="btn btn-sm btn-primary" onClick={() => setLearning(false)} title="Esci dal MIDI learn (Esc, Ctrl+M)">
        Fine
      </button>
    </div>
  );
}
