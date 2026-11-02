import { formatDuration } from '../shared/setlists.js';
import { useEngineStatus } from '../lib/engine';
import { sectionIndexAt } from '../lib/sections';
import { useSettings } from '../lib/settings';
import { useSections } from '../lib/useSections';
import Icon from './Icon';

// List of the sections of the song in the player ("Sezioni" tab of the sidebar),
// as the marker window of a DAW: a click goes there, the name is written in place.
export default function SectionsPanel({ player, setlistId, canEdit, notify }) {
  const [settings] = useSettings();
  const sec = useSections({ player, setlistId, canEdit, notify, quant: settings.jumpQuant });
  const now = useEngineStatus((s) => sectionIndexAt(sec.sections, Math.max(0, s.position)));
  if (!player.loaded) return <p className="small muted sp-empty">Carica un brano: qui compaiono le sue sezioni.</p>;
  return (
    <div className="sp">
      <div className="sp-head">
        <button className="btn btn-sm" onClick={sec.addAtPlayhead} disabled={!sec.editable} title="Aggiunge una sezione alla battuta della testina (Ins nell’Arrangement)">
          <Icon name="marker-add" size={14} /> Aggiungi
        </button>
        <span className="grow" />
        {sec.dirty && sec.editable && (
          <button className="btn btn-sm btn-primary" onClick={sec.save} disabled={sec.saving} title="Salva il brano per tutta la band">
            <Icon name="check" size={13} /> {sec.saving ? 'Salvo…' : 'Salva'}
          </button>
        )}
      </div>
      {!sec.sections.length && <p className="small muted sp-empty">Nessuna sezione in questo brano.</p>}
      <div className="sp-list">
        {sec.sections.map((s, i) => (
          <div key={s.index} className={`sp-row ${i === now ? 'is-now' : ''}`} style={{ '--sec': s.color }}>
            <button className="sp-go" onClick={() => sec.go(s)} title={`Vai a ${s.label}`} aria-label={`Vai a ${s.label}`}>
              {i + 1}
            </button>
            <input
              key={`${s.index}-${s.name}`}
              className="sp-name"
              defaultValue={s.name}
              placeholder={s.label}
              readOnly={!sec.editable}
              aria-label={`Nome della sezione ${i + 1}`}
              onBlur={(e) => {
                const label = e.target.value.trim();
                if (label !== s.name) sec.rename(s.index, label);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.target.blur();
                if (e.key === 'Escape') {
                  e.target.value = s.name;
                  e.target.blur();
                }
              }}
            />
            <span className="sp-info mono" title={`Dalla battuta ${s.bar}, ${formatDuration(s.end - s.start)}`}>
              {s.bar}
            </span>
            {sec.editable && (
              <button className="sp-del" onClick={() => sec.remove(s.index)} title="Elimina: la sezione prima prende le sue battute" aria-label={`Elimina ${s.label}`}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
