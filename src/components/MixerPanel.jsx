import { useRef, useState } from 'react';
import ChannelPanel from './ChannelPanel';
import Fader from './Fader';
import Icon from './Icon';
import Meter from './Meter';
import { openContextMenu } from './ContextMenu';
import { automationDb, automationMutedAt } from '../shared/media.js';
import { useEngineStatus } from '../lib/engine';

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
          <option key={r.value} value={`r:${r.value}`} disabled={!state.canEdit || ((strip.live || strip.video) && r.value !== strip.role)}>
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
  if (!strip.instrument || strip.live || strip.video) return <span className="mx-instr is-blank" />;
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

// R/W of the channel as in Cubase: with R on the fader and M follow the
// automations while the song plays; W armed writes them (fader grabbed, M).
function AutoButtons({ strip, state, dispatch }) {
  if (strip.live || strip.video) return null;
  const can = state.canEdit;
  return (
    <>
      <button
        className={`st-solo mx-read ${strip.read && strip.hasAuto ? 'is-on' : ''}`}
        onClick={() => dispatch({ type: 'read', id: strip.id })}
        disabled={!can || !strip.hasAuto}
        aria-pressed={strip.read}
        title={strip.hasAuto ? `Lettura automazione (R): ${strip.read ? 'attiva, volume e mute seguono le curve' : 'spenta, la traccia resta al fader'} · si salva con il brano` : 'Lettura automazione (R): la traccia non ha automazioni (W per scriverle, o lo strumento Automazione)'}
      >
        R
      </button>
      <button
        className={`st-solo mx-write ${strip.write ? 'is-on' : ''}`}
        onClick={() => dispatch({ type: 'write', id: strip.id })}
        disabled={!can}
        aria-pressed={strip.write}
        title={can ? 'Scrittura automazione (W): mentre il brano suona, il fader e M di questa traccia scrivono l’automazione (poi “Salva”). Solo su questo dispositivo' : 'Solo chi può modificare il brano scrive le automazioni'}
      >
        W
      </button>
    </>
  );
}

function Strip({ strip, state, dispatch, here, onOpen, open = false }) {
  const { dragging, begin } = useDrag(dispatch);
  const set = (type, value) => dispatch({ type, id: strip.id, value, live: dragging.current });
  const locked = !state.canEdit;
  // Fader and M where the automations are now (R on, playing).
  const follows = strip.read && strip.hasAuto;
  const pos = useEngineStatus((s) => (follows && s.playing && !s.waiting ? Math.round(Math.max(0, s.position) * 25) / 25 : null));
  const autoDb = pos != null && strip.auto.length ? automationDb(strip.auto, pos) : 0;
  const level = Math.max(-60, Math.min(6, strip.gain + autoDb));
  const autoMute = pos != null && automationMutedAt(strip.muteAuto, pos);
  const mute = strip.mute || autoMute;
  // Right click / long press on the strip.
  const menu = (e) => {
    const auto = !strip.live && !strip.video && state.canEdit;
    openContextMenu(
      e,
      [
        { label: 'Volume a 0 dB', icon: 'undo', disabled: locked || strip.gain === 0, onSelect: () => dispatch({ type: 'gain', id: strip.id, value: 0 }) },
        { label: 'Pan al centro', icon: 'undo', disabled: locked || strip.pan === 0, onSelect: () => dispatch({ type: 'pan', id: strip.id, value: 0 }) },
        '-',
        { label: 'Muto', checked: strip.mute, onSelect: () => dispatch({ type: 'mute', id: strip.id }) },
        { label: 'Solo', checked: strip.solo, disabled: strip.index < 0, onSelect: () => dispatch({ type: 'solo', id: strip.id }) },
        auto && strip.hasAuto && { label: 'Leggi l’automazione (R)', checked: strip.read, onSelect: () => dispatch({ type: 'read', id: strip.id }) },
        auto && { label: 'Scrivi l’automazione (W)', checked: strip.write, onSelect: () => dispatch({ type: 'write', id: strip.id }) },
        '-',
        { label: open ? 'Chiudi la sezione canale' : 'Sezione canale (gain, EQ)…', icon: 'sliders', onSelect: onOpen },
        state.dirty && { label: 'Salva il brano', icon: 'check', disabled: state.saving, onSelect: () => dispatch({ type: 'save' }) },
      ],
      { title: strip.name },
    );
  };
  return (
    <div onContextMenu={menu} className={`st-strip mx-strip ${mute || strip.out ? 'is-muted' : ''} ${strip.index < 0 ? 'is-absent' : ''} ${open ? 'is-open' : ''}`} style={{ '--sec': strip.color }}>
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
      <span className={`m-db ${autoDb ? 'is-auto' : ''}`}>{dbText(level)}</span>
      <div className={`st-fader-row ${locked ? 'is-locked' : ''}`} onPointerDown={locked ? undefined : begin}>
        <Fader
          value={level}
          // W: the level where the fader is (written on top of its own); else the fader's own, under the automation.
          onChange={(v) => !locked && set('gain', strip.write ? v : v - autoDb)}
          onReset={() => !locked && dispatch({ type: 'gain', id: strip.id, value: 0 })}
          title={locked ? 'Solo chi può modificare il brano cambia i volumi' : strip.write ? `Volume ${strip.name}: W attivo, mentre suona il fader scrive l’automazione` : `Volume ${strip.name} (doppio clic: 0 dB)`}
          scale={false}
        />
        {strip.index >= 0 && <Meter track={strip.index} />}
      </div>
      <span className="mx-btns">
        <button
          className={`st-solo mx-mute ${mute ? 'is-on' : ''} ${autoMute && !strip.mute ? 'is-auto' : ''}`}
          onClick={() => dispatch({ type: 'mute', id: strip.id })}
          aria-pressed={mute}
          title={strip.write ? 'Mute: W attivo, mentre suona scrive l’automazione del mute' : autoMute && !strip.mute ? 'Mutata dall’automazione' : state.canEdit ? 'Mute (salvato con il brano)' : `Mute (su ${here})`}
        >
          M
        </button>
        <button className={`st-solo ${strip.solo ? 'is-on' : ''}`} onClick={() => dispatch({ type: 'solo', id: strip.id })} disabled={strip.index < 0} aria-pressed={strip.solo} title="Solo">
          S
        </button>
        <AutoButtons strip={strip} state={state} dispatch={dispatch} />
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
