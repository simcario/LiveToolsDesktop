import { useEffect, useRef, useState } from 'react';
import { CUE_GROUPS, previewCue } from '../lib/cueTrack';
import Icon from './Icon';

// Menu of the spoken cues for one square of the cue track (search, groups, listen).
export function CuePicker({ cell, rect, current, beatsInBar, onPick, onCount, onClear, onClose }) {
  const [q, setQ] = useState('');
  const box = useRef(null);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    const onDown = (e) => !box.current?.contains(e.target) && onClose();
    window.addEventListener('keydown', onKey);
    // Listened from the next task: the mousedown of the click that opened
    // the menu comes after its pointerdown and would close it at once.
    const timer = setTimeout(() => window.addEventListener('mousedown', onDown));
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);
  const s = q.trim().toLowerCase();
  const groups = CUE_GROUPS.map(([name, labels]) => [name, labels.filter((l) => !s || l.toLowerCase().includes(s))]).filter(([, l]) => l.length);
  const top = Math.min(rect.bottom + 4, window.innerHeight - 380);
  const left = Math.min(rect.left, window.innerWidth - 440);
  const choose = (label) => {
    if (s && !label) return;
    onPick(label);
  };
  return (
    <div className="cue-picker" ref={box} style={{ top: Math.max(8, top), left: Math.max(8, left) }}>
      <div className="cue-picker-head">
        <strong>
          Battuta {cell.bar} · {cell.half ? `${cell.beat + 1}+` : cell.beat + 1}
        </strong>
        <span className="grow" />
        {current && (
          <button className="btn btn-sm btn-ghost" onClick={onClear} title="Togli la cue da questo quadratino">
            <Icon name="trash" size={12} /> Togli
          </button>
        )}
        {!cell.half && cell.beat === 0 && (
          <button className="btn btn-sm" onClick={onCount} title={`One!… su ogni movimento della battuta (${beatsInBar})`}>
            Conteggio 1–{beatsInBar}
          </button>
        )}
      </div>
      <input
        className="input"
        autoFocus
        placeholder="Cerca una cue… (Invio sceglie la prima)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && groups[0] && choose(groups[0][1][0])}
      />
      <div className="cue-picker-list">
        {groups.map(([name, labels]) => (
          <div key={name} className="cue-group">
            <span className="cue-group-name">{name}</span>
            <div className="cue-chips">
              {labels.map((l) => (
                <span key={l} className={`cue-chip ${l === current ? 'is-on' : ''}`}>
                  <button type="button" onClick={() => choose(l)}>
                    {l}
                  </button>
                  <button type="button" className="cue-listen" onClick={() => previewCue(l).catch(() => {})} title="Ascolta">
                    <Icon name="play" size={9} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <p className="small muted">Nessuna cue trovata.</p>}
      </div>
    </div>
  );
}

