import { autoSource, gridOf } from '../lib/sync';

// Which stem the click/grid follows, what was found, and fine corrections.
export default function SyncControl({ player, compact = false }) {
  const loaded = player.loaded;
  if (!loaded) return null;
  const stems = loaded.tracks.map((t) => t.stem);
  const sync = loaded.sync || {};
  const choice = sync.choice || { source: 'auto', nudgeMs: 0, shiftBeats: 0 };
  const auto = autoSource(stems);
  const a = sync.analysis;
  const set = (patch) => player.changeSync(patch);
  // Anchors set by hand replace the analysis (and its corrections).
  const manual = gridOf(player.loadedItem).anchors.length;

  return (
    <span className="sync-ctl" title="Allineamento del click e della griglia all’audio del brano">
      <span className="small faint">Griglia</span>
      <select
        className="select-xs"
        value={choice.source}
        onChange={(e) => set({ source: e.target.value, nudgeMs: 0, shiftBeats: 0 })}
        aria-label="Traccia di riferimento"
      >
        <option value="auto">Auto{auto ? ` (${auto.stem.name})` : ' (nessuna traccia)'}</option>
        {stems.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        <option value="none">Dati del brano (da 0)</option>
      </select>
      {manual > 0 && <span className="small sync-info">a mano · {manual} ancoraggi</span>}
      {a && !manual && (
        <span className="small mono sync-info">
          {sync.source?.mode === 'click' ? 'click' : 'ritmo'} · {a.bpm.toFixed(2)} BPM · 1 a {(a.origin + (choice.nudgeMs || 0) / 1000).toFixed(3)} s
          <span className={a.confidence > 0.75 ? 'ok' : a.confidence > 0.45 ? 'warn' : 'err'}> {Math.round(a.confidence * 100)}%</span>
        </span>
      )}
      {sync.error && <span className="small sync-info err">{sync.error}</span>}
      {a && !manual && (
        <>
          <button className="toggle" onClick={() => set({ shiftBeats: (choice.shiftBeats || 0) - 1 })} title="Sposta il 1 di un movimento indietro">
            ◀ 1
          </button>
          <button className="toggle" onClick={() => set({ shiftBeats: (choice.shiftBeats || 0) + 1 })} title="Sposta il 1 di un movimento avanti">
            1 ▶
          </button>
          {!compact && (
            <>
              <button className="toggle" onClick={() => set({ nudgeMs: (choice.nudgeMs || 0) - 5 })} title="Anticipa la griglia di 5 ms">
                −5ms
              </button>
              <span className="small mono">{choice.nudgeMs > 0 ? '+' : ''}{choice.nudgeMs || 0}</span>
              <button className="toggle" onClick={() => set({ nudgeMs: (choice.nudgeMs || 0) + 5 })} title="Ritarda la griglia di 5 ms">
                +5ms
              </button>
            </>
          )}
          {(choice.nudgeMs || choice.shiftBeats) ? (
            <button className="toggle" onClick={() => set({ nudgeMs: 0, shiftBeats: 0 })} title="Annulla le correzioni">
              ↺
            </button>
          ) : null}
        </>
      )}
    </span>
  );
}
