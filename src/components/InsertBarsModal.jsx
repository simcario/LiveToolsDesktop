import { useEffect, useState } from 'react';
import { engineStatus } from '../lib/engine';
import { barAt, insertBars } from '../lib/arrange';
import { recordStep } from '../lib/arrangeHistory';
import Icon from './Icon';

// "Aggiungi → Battute…": how many empty bars to insert at the bar where the
// playhead is (1 by default). Everything after them moves later.
export default function InsertBarsModal({ player, onClose, notify }) {
  const [n, setN] = useState(1);
  const [busy, setBusy] = useState(false);
  const item = player.loadedItem;
  const tempo = player.loaded?.tempo;
  const bar = tempo ? barAt(tempo, Math.max(0, engineStatus().position)) : null;
  const seconds = bar ? n * bar.beats * bar.beat : 0;

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (e) => {
    e.preventDefault();
    if (!bar || !(n >= 1)) return;
    setBusy(true);
    try {
      if (engineStatus().playing) await player.stop();
      const res = await insertBars({ item, tempo, position: engineStatus().position, n });
      recordStep(item.id, res.step);
      await player.load(res.item);
      player.locate(bar.t);
      notify(
        `Inserit${n === 1 ? 'a 1 battuta' : `e ${n} battute`} prima della battuta ${res.bar} (+${res.seconds.toFixed(2)} s)${res.notes.length ? `: ${res.notes.join(', ')}` : ''}`,
      );
      onClose();
    } catch (er) {
      notify(`Battute non inserite: ${er.message || er}`, true);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="modal modal-sm" role="dialog" aria-modal="true" aria-label="Inserisci battute" onSubmit={run}>
        <div className="modal-head">
          <h2>Inserisci battute</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Chiudi" disabled={busy}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal-body">
          {!bar ? (
            <p className="small muted">La griglia non è disponibile: imposta BPM e metro del brano.</p>
          ) : (
            <>
              <label className="field">
                <span>Quante battute</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={64}
                  step={1}
                  autoFocus
                  value={n}
                  onChange={(e) => setN(Math.max(1, Math.min(64, Math.round(Number(e.target.value) || 1))))}
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <p className="small muted">
                Vuote, prima della battuta <strong>{bar.bar}</strong> (dove si trova la testina): {n * bar.beats} movimenti, {seconds.toFixed(2)} s.
                Tutte le tracce vengono tagliate lì e la parte successiva si sposta in avanti, insieme a griglia, cue, cambi del
                gobbo e sezioni. I file audio non vengono modificati.
              </p>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>
            Annulla
          </button>
          <button className="btn btn-sm btn-primary" disabled={!bar || busy}>
            {busy ? 'Inserimento…' : `Inserisci ${n === 1 ? '1 battuta' : `${n} battute`}`}
          </button>
        </div>
      </form>
    </div>
  );
}
