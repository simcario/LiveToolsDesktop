// Bars of commands, made of groups by category: a group never splits and goes
// to a new line when the bar is full. Order, hidden groups and forced new lines
// are the user's, per bar, on this computer (settings.toolbars).
import { Children, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettings } from '../lib/settings';
import Icon from './Icon';

/** A category of commands. locked: always shown. grow: takes the free room of its line.
 * pin: stays in the bar when the bar has `overflow` (the other groups go under ⋯).
 * corner: fixed in the top right corner, whatever the order and the lines of the others. */
export function ToolGroup({ label, grow = false, children }) {
  return (
    <div className={`tb-group ${grow ? 'is-grow' : ''}`} role="group" aria-label={label}>
      <span className="tb-cap">{label}</span>
      {children}
    </div>
  );
}

// The groups present now in the user's order; a group never moved stays after
// the one it follows by default.
function arrange(groups, order) {
  const ids = groups.map((g) => g.props.id);
  const list = (order || []).filter((id) => ids.includes(id));
  ids.forEach((id, i) => {
    if (list.includes(id)) return;
    const before = ids
      .slice(0, i)
      .reverse()
      .find((x) => list.includes(x));
    list.splice(before ? list.indexOf(before) + 1 : 0, 0, id);
  });
  return list.map((id) => groups.find((g) => g.props.id === id));
}

function ToolbarPanel({ title, groups, conf, onChange, onReset, labels, onLabels, onClose }) {
  const hidden = conf.hidden || [];
  const breaks = conf.breaks || [];
  const toggle = (key, list, id) => onChange({ [key]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] });
  const moveTo = (id, to) => {
    const ids = groups.map((g) => g.props.id).filter((x) => x !== id);
    if (to < 0 || to > ids.length) return;
    ids.splice(to, 0, id);
    onChange({ order: ids });
  };
  // By the handle only, as the other lists of the app.
  const drag = (e, id) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const list = handle.closest('.tb-list');
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const rows = [...list.children];
      const at = rows.filter((r) => r.dataset.id !== id && ev.clientY > r.getBoundingClientRect().top + r.offsetHeight / 2).length;
      if (rows.findIndex((r) => r.dataset.id === id) !== at) moveTo(id, at);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      // The keys stay here: Space must not start the music from this panel.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="modal modal-sm tb-panel" role="dialog" aria-modal="true" aria-label={`Personalizza la barra ${title}`} tabIndex={-1} ref={(el) => el && !el.contains(document.activeElement) && el.focus()}>
        <div className="modal-head">
          <h2>Barra {title}</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Chiudi">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <p className="small muted tb-hint">Trascina la maniglia per cambiare l’ordine. Quando lo spazio finisce, i gruppi vanno a capo da soli.</p>
          <div className="tb-list">
            {groups.map((g, i) => {
              const { id, label, locked } = g.props;
              return (
                <div key={id} className="tb-row" data-id={id}>
                  <button
                    type="button"
                    className="tb-grip"
                    onPointerDown={(e) => drag(e, id)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowUp') moveTo(id, i - 1);
                      if (e.key === 'ArrowDown') moveTo(id, i + 1);
                    }}
                    aria-label={`Sposta ${label} (frecce su e giù)`}
                    title="Trascina per spostare"
                  >
                    <Icon name="grip" size={15} />
                  </button>
                  <label className="tb-show" title={locked ? 'Questo gruppo resta sempre visibile' : undefined}>
                    <input type="checkbox" checked={!hidden.includes(id)} disabled={locked} onChange={() => toggle('hidden', hidden, id)} />
                    {label}
                  </label>
                  <button
                    type="button"
                    className={`toggle ${breaks.includes(id) ? 'is-on' : ''}`}
                    disabled={i === 0}
                    aria-pressed={breaks.includes(id)}
                    onClick={() => toggle('breaks', breaks, id)}
                    title="Fa partire questo gruppo da una riga nuova"
                  >
                    Nuova riga
                  </button>
                </div>
              );
            })}
          </div>
          <label className="tb-show tb-labels">
            <input type="checkbox" checked={labels} onChange={onLabels} />
            Mostra i nomi delle categorie su tutte le barre
          </label>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onReset}>
            Ripristina
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={onClose}>
            Fine
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// overflow: only the groups with `pin` stay in the bar, the others open from the ⋯ button
// (a tablet, where a bar of many lines would leave no room).
export default function Toolbar({ id, title, className = '', as: Tag = 'div', overflow = false, children }) {
  const [settings, update] = useSettings();
  const [open, setOpen] = useState(false);
  const conf = settings.toolbars?.[id] || {};
  const save = (patch) => update((s) => ({ toolbars: { ...s.toolbars, [id]: { ...(s.toolbars?.[id] || {}), ...patch } } }));
  const groups = arrange(Children.toArray(children).filter(Boolean), conf.order);
  const hidden = conf.hidden || [];
  const breaks = conf.breaks || [];
  // corner: always in the top right corner of the bar, out of the order and of the new lines.
  const corner = overflow ? [] : groups.filter((g) => g.props.corner);
  const movable = groups.filter((g) => !corner.includes(g));
  const shown = movable.filter((g) => g.props.locked || !hidden.includes(g.props.id));
  const inBar = overflow ? shown.filter((g) => g.props.pin) : shown;
  const inMore = overflow ? shown.filter((g) => !g.props.pin) : [];
  const [more, setMore] = useState(false);
  const moreRef = useRef(null);
  // A touch outside closes the ⋯ panel; inside it stays open (zoom can be pressed again and again).
  useEffect(() => {
    if (!more) return undefined;
    const down = (e) => !moreRef.current?.contains(e.target) && !e.target.closest?.('.modal-backdrop, .cue-picker') && setMore(false);
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [more]);
  const flow = (
    <>
      {inBar.flatMap((g, i) => [i > 0 && !overflow && breaks.includes(g.props.id) ? <span key={`br-${g.props.id}`} className="tb-break" /> : null, g])}
      {overflow && (
        <span className="tb-more-wrap" ref={moreRef}>
          <button className={`tb-more ${more ? 'is-on' : ''}`} onClick={() => setMore((v) => !v)} aria-expanded={more} aria-label="Altri comandi" title="Altri comandi">
            <Icon name="more" size={20} />
          </button>
          {more && (
            <div className="tb-pop" role="dialog" aria-label={`Altri comandi: ${title}`}>
              {inMore}
              <button
                className="tb-pop-custom"
                onClick={() => {
                  setMore(false);
                  setOpen(true);
                }}
              >
                <Icon name="sliders" size={14} /> Personalizza la barra
              </button>
            </div>
          )}
        </span>
      )}
      {!overflow && (
        <button className="tb-custom" onClick={() => setOpen(true)} title={`Personalizza la barra ${title}`} aria-label={`Personalizza la barra ${title}`}>
          <Icon name="sliders" size={14} />
        </button>
      )}
    </>
  );
  return (
    <Tag
      className={`tb ${className} ${settings.toolbarLabels ? 'tb-labeled' : ''} ${corner.length ? 'tb-has-corner' : ''}`}
      onContextMenu={(e) => {
        if (e.target.closest('input, select, textarea')) return;
        e.preventDefault();
        setOpen(true);
      }}
    >
      {corner.length ? (
        <>
          <div className="tb-flow">{flow}</div>
          <div className="tb-corner">{corner}</div>
        </>
      ) : (
        flow
      )}
      {open && (
        <ToolbarPanel
          title={title}
          groups={movable}
          conf={conf}
          onChange={save}
          onReset={() => save({ order: undefined, hidden: undefined, breaks: undefined })}
          labels={!!settings.toolbarLabels}
          onLabels={() => update((s) => ({ toolbarLabels: !s.toolbarLabels }))}
          onClose={() => setOpen(false)}
        />
      )}
    </Tag>
  );
}
