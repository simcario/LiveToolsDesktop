import { useRef, useState } from 'react';
import ChannelPanel from './ChannelPanel';
import Fader from './Fader';
import Icon from './Icon';
import Meter from './Meter';

// The mixer of the song in the player, drawn the same in the Dettaglio tab and
// in its own window (F3). `state` and `dispatch` come from lib/useMixer.js.
const dbText = (db) => (db <= -60 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);
const panText = (p) => (Math.abs(p) < 0.005 ? 'C' : `${p < 0 ? 'L' : 'R'}${Math.round(Math.abs(p) * 100)}`);

// Routing as in Cubase: one menu with the destination of the track, its role
// (saved with the song: the outputs of the role, as in the Sequenze view) or an
// output of this computer. Below it the instrument, for the Rehearsal.
function RouteSelect({ strip, state, dispatch, here }) {
  const value = strip.route ? `o:${strip.route}` : `r:${strip.role}`;
  return (
    <select
      className="mx-route"
      value={value}
      onChange={(e) => {
        const [kind, v] = [e.target.value.slice(0, 1), e.target.value.slice(2)];
        dispatch(kind === 'r' ? { type: 'role', id: strip.id, value: v } : { type: 'route', id: strip.id, value: v });
        e.target.blur();
      }}
      title={`Destinazione: ruolo (salvato con il brano) o uscita diretta di ${here}${strip.route ? '' : ` · ${state.roles.find((r) => r.value === strip.role)?.hint || ''}`}`}
      aria-label={`Destinazione di ${strip.name}`}
    >
      <optgroup label="Ruolo">
        {state.roles.map((r) => (
          <option key={r.value} value={`r:${r.value}`} disabled={!state.canEdit || (strip.live && r.value !== strip.role)}>
            {r.label}
          </option>
        ))}
      </optgroup>
      <optgroup label={`Uscita diretta (${here})`}>
        {state.outputs.map((o) => (
          <option key={o.value} value={`o:${o.value}`}>
            {o.label}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

// Instrument of the track (Main and Monitor only): the Rehearsal of who plays it leaves it out.
function InstrumentSelect({ strip, state, dispatch }) {
  if (!strip.instrument || strip.live) return <span className="mx-instr is-blank" />;
  return (
    <select
      className="mx-route mx-instr"
      value={strip.instrument}
      disabled={!state.canEdit}
      onChange={(e) => {
        dispatch({ type: 'instrument', id: strip.id, value: e.target.value });
        e.target.blur();
      }}
      title="Strumento: il Rehearsal di chi lo suona lo toglie dal mix"
      aria-label={`Strumento di ${strip.name}`}
    >
      {state.instruments.map((i) => (
        <option key={i.value} value={i.value}>
          {i.label}
        </option>
      ))}
    </select>
  );
}

// A drag (fader, pan, EQ point or knob) is one undo step: closed when the
// button is released, wherever it is.
function useDrag(dispatch) {
  const dragging = useRef(false);
  const send = useRef(dispatch);
  send.current = dispatch;
  const begin = () => {
    dragging.current = true;
    window.addEventListener(
      'pointerup',
      () => {
        dragging.current = false;
        send.current({ type: 'end' });
      },
      { once: true },
    );
  };
  return { dragging, begin };
}

function Strip({ strip, state, dispatch, here, onOpen, open = false }) {
  const { dragging, begin } = useDrag(dispatch);
  const set = (type, value) => dispatch({ type, id: strip.id, value, live: dragging.current });
  const locked = !state.canEdit;
  return (
    <div className={`st-strip mx-strip ${strip.mute || strip.out ? 'is-muted' : ''} ${strip.index < 0 ? 'is-absent' : ''} ${open ? 'is-open' : ''}`} style={{ '--sec': strip.color }}>
      <RouteSelect strip={strip} state={state} dispatch={dispatch} here={here} />
      <InstrumentSelect strip={strip} state={state} dispatch={dispatch} />
      <span className="mx-pan" title={`Pan ${panText(strip.pan)} (doppio clic: centro)`}>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.02}
          value={strip.pan}
          disabled={locked}
          onPointerDown={begin}
          onChange={(e) => set('pan', Number(e.target.value))}
          onDoubleClick={() => dispatch({ type: 'pan', id: strip.id, value: 0 })}
          aria-label={`Pan di ${strip.name}`}
        />
        <span className="m-db">{panText(strip.pan)}</span>
      </span>
      <span className="m-db">{dbText(strip.gain)}</span>
      <div className={`st-fader-row ${locked ? 'is-locked' : ''}`} onPointerDown={locked ? undefined : begin}>
        <Fader
          value={strip.gain}
          onChange={(v) => !locked && set('gain', v)}
          onReset={() => !locked && dispatch({ type: 'gain', id: strip.id, value: 0 })}
          title={locked ? 'Solo chi può modificare il brano cambia i volumi' : `Volume ${strip.name} (doppio clic: 0 dB)`}
          scale={false}
        />
        {strip.index >= 0 && <Meter track={strip.index} />}
      </div>
      <span className="mx-btns">
        <button className={`st-solo mx-mute ${strip.mute ? 'is-on' : ''}`} onClick={() => dispatch({ type: 'mute', id: strip.id })} aria-pressed={strip.mute} title={`Mute (su ${here})`}>
          M
        </button>
        <button className={`st-solo ${strip.solo ? 'is-on' : ''}`} onClick={() => dispatch({ type: 'solo', id: strip.id })} disabled={strip.index < 0} aria-pressed={strip.solo} title="Solo">
          S
        </button>
      </span>
      <button
        className={`st-name mx-name ${open ? 'is-open' : ''}`}
        onClick={onOpen}
        title={`${strip.name}${strip.file ? ` · ${strip.file}` : ''}${strip.index < 0 ? ' · non nel player (non scaricata o brano non caricato)' : ''} · clic: sezione canale (gain, EQ)`}
      >
        <span className="ellipsis">{strip.name}</span>
        {strip.channel && <span className="mx-eq-badge" title="Gain o EQ modificati">EQ</span>}
      </button>
    </div>
  );
}

// here: the device for what stays local; windowButton: false where there is no F3 window.
// compact (tablet tab): no head bar; Ripristina and Salva in a thin column before the strips.
export default function MixerPanel({ state, dispatch, inWindow = false, here = 'questo computer', windowButton = true, compact = false }) {
  // Channel section open (click on a track name): the id of its track.
  const [channel, setChannel] = useState(null);
  const chDrag = useDrag(dispatch);
  const open = state.strips.findIndex((s) => s.id === channel);
  const step = (dir) => {
    const n = state.strips.length;
    if (n) setChannel(state.strips[(open + dir + n) % n].id);
  };
  const reset = () => dispatch({ type: 'reset' });
  const canReset = state.canEdit && state.changed;
  return (
    <section className={`mx ${inWindow ? 'is-window' : ''} ${compact ? 'is-compact' : ''}`}>
      {!compact && (
        <div className="mx-head">
          <Icon name="sliders" size={13} />
          <strong className="ellipsis">Mixer{state.song ? ` · ${state.song.title}` : ''}</strong>
          <span className="small faint ellipsis mx-hint">
            {state.canEdit ? `Clic sul nome di una traccia: gain ed EQ · volumi, pan, ruolo, strumento ed EQ si salvano con il brano · mute, solo e uscite dirette restano su ${here}` : 'Solo chi può modificare il brano cambia volumi, ruoli e strumenti'}
          </span>
          <span className="grow" />
          <button className="btn btn-sm" onClick={reset} disabled={!canReset} title="Riporta tutte le tracce a 0 dB e pan al centro (poi “Salva”)">
            <Icon name="undo" size={13} /> Ripristina volumi
          </button>
          {state.dirty && (
            <>
              <span className="small arr-unsaved">Non salvato</span>
              <button className="btn btn-sm btn-primary" onClick={() => dispatch({ type: 'save' })} disabled={state.saving} title="Salva il brano per tutta la band">
                <Icon name="check" size={13} /> {state.saving ? 'Salvataggio…' : 'Salva'}
              </button>
            </>
          )}
          {windowButton && (
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'window' })} title={inWindow ? 'Chiudi la finestra del mixer (F3)' : 'Apri il mixer in una finestra separata (F3)'}>
              <Icon name={inWindow ? 'x' : 'maximize'} size={13} /> {inWindow ? 'Chiudi' : 'Finestra'}
            </button>
          )}
        </div>
      )}
      <div className="mx-strips">
        {compact && (
          <span className="mx-side">
            <button className="btn btn-icon" onClick={reset} disabled={!canReset} title="Ripristina volumi: tutte le tracce a 0 dB e pan al centro (poi “Salva”)" aria-label="Ripristina volumi">
              <Icon name="undo" size={18} />
            </button>
            {state.dirty && (
              <button className="btn btn-icon btn-primary" onClick={() => dispatch({ type: 'save' })} disabled={state.saving} title="Salva il brano per tutta la band" aria-label="Salva">
                <Icon name="check" size={18} />
              </button>
            )}
          </span>
        )}
        {open >= 0 ? (
          <>
            <ChannelPanel
              strip={state.strips[open]}
              state={state}
              dispatch={dispatch}
              onClose={() => setChannel(null)}
              onStep={step}
              begin={chDrag.begin}
              dragging={chDrag.dragging}
            />
            <Strip strip={state.strips[open]} state={state} dispatch={dispatch} here={here} open onOpen={() => setChannel(null)} />
          </>
        ) : state.strips.length ? (
          state.strips.map((s) => <Strip key={s.id} strip={s} state={state} dispatch={dispatch} here={here} onOpen={() => setChannel(s.id)} />)
        ) : (
          <p className="muted small mx-empty">{state.song ? 'Il brano non ha tracce: caricale dalla vista Sequenze della scaletta.' : 'Carica un brano nel player: le sue tracce compaiono qui.'}</p>
        )}
      </div>
    </section>
  );
}
