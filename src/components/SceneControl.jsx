import { useEffect, useState } from 'react';
import { groupOptions, stemsOf } from '../shared/media.js';
import { clearSongScene, createScene, deleteScene, setActiveScene, songHasScene, updateScene, useScenes } from '../lib/scenes';
import { writeMix } from '../lib/songMix';
import Icon from './Icon';

// Scene del mix (lib/scenes.js): the menu that picks one (Arrangement, Mixer, Palco) and the window
// that makes them. `song`: the song in the player, for "Togli le modifiche di questo brano".

const EXTRA_GROUPS = [
  { value: 'click', label: 'Traccia click' },
  { value: 'guide', label: 'Guide' },
];

function SceneModal({ song, canEdit, onClose, notify }) {
  const { list, active } = useScenes();
  const [editing, setEditing] = useState(active);
  const [name, setName] = useState('');
  const scene = list.find((s) => s.id === editing) || null;
  const groups = [...groupOptions(stemsOf(song)), ...EXTRA_GROUPS];

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const add = (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setEditing(createScene(n));
    setName('');
    notify?.(`Scena “${n}” creata e attiva: le modifiche al mix dei brani ora vanno in questa scena`);
  };
  const toggleGroup = (g) => {
    const has = scene.muteGroups.includes(g);
    updateScene(scene.id, { muteGroups: has ? scene.muteGroups.filter((x) => x !== g) : [...scene.muteGroups, g] });
  };
  const remove = () => {
    if (!scene) return;
    if (confirm(`Eliminare la scena “${scene.name}”? I brani tornano al loro mix (Base).`)) {
      deleteScene(scene.id);
      setEditing(null);
    }
  };
  const clearSong = () => {
    if (!song || !scene) return;
    writeMix(song, clearSongScene(song, scene.id), `“${song.title}”: scena ${scene.name} senza modifiche`);
    notify?.(`“${song.title}” nella scena “${scene.name}” segue solo le regole della scena (poi “Salva”)`);
  };

  return (
    <div className="modal-backdrop scene-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal scene-modal" role="dialog" aria-modal="true" aria-label="Scene del mix">
        <div className="modal-head">
          <h2>Scene del mix</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Chiudi">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal-body scene-body">
          <p className="small muted">
            Una scena è una versione del mix valida per tutti i brani: per esempio “Live con la band”, con i canali degli strumenti suonati dal vivo mutati. Con una scena attiva, mute,
            volumi e automazioni che cambi in un brano (Arrangement, Mixer) si salvano nel brano per quella scena; “Base” è il mix normale del brano.
          </p>
          <div className="scene-layout">
            <ul className="scene-list" role="listbox" aria-label="Scene">
              <li>
                <button className={`scene-item ${editing == null ? 'is-sel' : ''}`} onClick={() => setEditing(null)}>
                  <span className="ellipsis">Base</span>
                  {active == null && <span className="scene-on">attiva</span>}
                </button>
              </li>
              {list.map((s) => (
                <li key={s.id}>
                  <button className={`scene-item ${editing === s.id ? 'is-sel' : ''}`} onClick={() => setEditing(s.id)}>
                    <span className="ellipsis">{s.name}</span>
                    {active === s.id && <span className="scene-on">attiva</span>}
                  </button>
                </li>
              ))}
              <li>
                <form className="scene-new" onSubmit={add}>
                  <input className="input input-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nuova scena…" maxLength={40} aria-label="Nome della nuova scena" />
                  <button className="btn btn-sm btn-icon" disabled={!name.trim()} title="Crea la scena" aria-label="Crea la scena">
                    <Icon name="plus" size={14} />
                  </button>
                </form>
              </li>
            </ul>
            <div className="scene-detail">
              {!scene ? (
                <>
                  <h3>Base</h3>
                  <p className="small muted">Il mix di ogni brano così come è salvato: mute, volumi e automazioni dell’Arrangement e del Mixer.</p>
                  <button className="btn btn-sm" onClick={() => setActiveScene(null)} disabled={active == null}>
                    <Icon name="check" size={13} /> Usa Base
                  </button>
                </>
              ) : (
                <>
                  <label className="field">
                    <span>Nome</span>
                    <input className="input input-sm" value={scene.name} maxLength={40} onChange={(e) => updateScene(scene.id, { name: e.target.value })} />
                  </label>
                  <label className="scene-check">
                    <input type="checkbox" checked={scene.clearMutes} onChange={(e) => updateScene(scene.id, { clearMutes: e.target.checked })} />
                    <span>
                      Parti senza mute
                      <span className="small faint">Le tracce mutate nei brani suonano (le automazioni del mute restano)</span>
                    </span>
                  </label>
                  <span className="label">Muta in tutti i brani</span>
                  <div className="scene-groups">
                    {groups.map((g) => (
                      <button key={g.value} className={`scene-chip ${scene.muteGroups.includes(g.value) ? 'is-on' : ''}`} onClick={() => toggleGroup(g.value)} aria-pressed={scene.muteGroups.includes(g.value)}>
                        {g.label}
                      </button>
                    ))}
                  </div>
                  <p className="small faint">I gruppi sono quelli Rehearsal delle tracce (Mixer › menu sotto la destinazione).</p>
                  <div className="scene-actions">
                    <button className="btn btn-sm btn-primary" onClick={() => setActiveScene(scene.id)} disabled={active === scene.id}>
                      <Icon name="check" size={13} /> {active === scene.id ? 'Attiva' : 'Attiva questa scena'}
                    </button>
                    {song && (
                      <button className="btn btn-sm" onClick={clearSong} disabled={!canEdit || !songHasScene(song, scene.id)} title="Il brano caricato torna alle sole regole della scena">
                        <Icon name="undo" size={13} /> Togli le modifiche di “{song.title}”
                      </button>
                    )}
                    <span className="grow" />
                    <button className="btn btn-sm btn-ghost btn-danger" onClick={remove}>
                      <Icon name="trash" size={13} /> Elimina
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Menu of the scenes and the button that opens their window. */
export default function SceneControl({ song, canEdit, notify, compact = false }) {
  const { list, active } = useScenes();
  const [open, setOpen] = useState(false);
  const scene = list.find((s) => s.id === active) || null;
  return (
    <span className={`scene-ctl ${scene ? 'is-scene' : ''}`}>
      <select
        className="scene-select"
        value={active || ''}
        onChange={(e) => {
          if (e.target.value === '+') setOpen(true);
          else setActiveScene(e.target.value || null);
          e.target.blur();
        }}
        title={scene ? `Scena “${scene.name}”: le modifiche al mix dei brani vanno in questa scena` : 'Scena del mix: Base (il mix salvato dei brani)'}
        aria-label="Scena del mix"
      >
        <option value="">{compact ? 'Base' : 'Scena: Base'}</option>
        {list.map((s) => (
          <option key={s.id} value={s.id}>
            {compact ? s.name : `Scena: ${s.name}`}
          </option>
        ))}
        <option value="+">Gestisci le scene…</option>
      </select>
      <button className="btn btn-sm btn-icon" onClick={() => setOpen(true)} title="Scene del mix: crea, rinomina, regole" aria-label="Gestisci le scene">
        <Icon name="layers" size={14} />
      </button>
      {open && <SceneModal song={song} canEdit={canEdit} notify={notify} onClose={() => setOpen(false)} />}
    </span>
  );
}
