import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import Meter from './Meter';
import { engine, engineStatus } from '../lib/engine';
import { BAND_TYPES, bandResponse, EQ_FREQ, EQ_GAIN, EQ_Q, eqResponse, freqText, INPUT_GAIN } from '../shared/eq.js';

// Channel section of a track, as on a digital desk (Mixing Station): input gain
// and EQ with high pass, five bands and low pass over the spectrum of the track.
// Opened by clicking the track name in the Mixer; values saved with the song
// (lib/useMixer.js, actions 'input' and 'eq'). Shared with LiveTools Mobile.
//
// Graph: drag a point (frequency and gain), wheel on it = width (Q), double
// click = gain 0 / pass on-off. The spectrum is read from the engine about 20
// times a second only while this panel is open (see audio/eq.rs).

const DB_RANGE = 18; // ± dB of the graph
const SPEC_FLOOR = -90; // dBFS at the bottom of the graph
const FREQ_LINES = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const DB_LINES = [12, 6, 0, -6, -12];
const BAND_COLORS = ['#f97316', '#eab308', '#22c55e', '#06b6d4', '#a855f7'];
const PASS_COLOR = '#94a3b8';
const KEYS = ['hpf', 0, 1, 2, 3, 4, 'lpf'];
const keyLabel = (k) => (k === 'hpf' ? 'HP' : k === 'lpf' ? 'LP' : String(k + 1));
const colorOf = (k) => (typeof k === 'number' ? BAND_COLORS[k] : PASS_COLOR);

const LOG_F = Math.log(EQ_FREQ[1] / EQ_FREQ[0]);
const fToX = (f, w) => (Math.log(f / EQ_FREQ[0]) / LOG_F) * w;
const xToF = (x, w) => Math.min(EQ_FREQ[1], Math.max(EQ_FREQ[0], EQ_FREQ[0] * Math.exp((x / w) * LOG_F)));
const gToY = (g, h) => h / 2 - (g / DB_RANGE) * (h / 2 - 6);
const yToG = (y, h) => Math.max(-EQ_GAIN, Math.min(EQ_GAIN, ((h / 2 - y) / (h / 2 - 6)) * DB_RANGE));
const LOG_Q = Math.log(EQ_Q[1] / EQ_Q[0]);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const roundF = (f) => (f < 100 ? round(f, 1) : f < 1000 ? Math.round(f) : Math.round(f / 10) * 10);
const dbText = (db) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;

// Log sliders (frequency, Q) on 0..1000.
const fToPos = (f) => Math.round((Math.log(f / EQ_FREQ[0]) / LOG_F) * 1000);
const posToF = (p) => roundF(EQ_FREQ[0] * Math.exp((p / 1000) * LOG_F));
const qToPos = (q) => Math.round((Math.log(q / EQ_Q[0]) / LOG_Q) * 1000);
const posToQ = (p) => round(EQ_Q[0] * Math.exp((p / 1000) * LOG_Q), 2);

function useCssVars(ref) {
  const vars = useRef(null);
  return () => {
    if (!vars.current && ref.current) {
      const cs = getComputedStyle(ref.current);
      const v = (n, d) => cs.getPropertyValue(n).trim() || d;
      vars.current = { text: v('--text-2', '#cbd5e1'), faint: v('--muted', '#64748b'), grid: v('--border-strong', 'rgba(255,255,255,0.14)') };
    }
    return vars.current;
  };
}

function EqGraph({ strip, sel, setSel, editEq, begin, locked }) {
  const canvas = useRef(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const spec = useRef(null);
  const drag = useRef(null);
  const frame = useRef(0);
  const live = useRef({ strip, sel });
  live.current = { strip, sel };
  const css = useCssVars(canvas);

  const draw = () => {
    frame.current = 0;
    const c = canvas.current;
    const { w, h, dpr } = size.current;
    if (!c || !w) return;
    const { strip: s, sel: k } = live.current;
    const eq = s.eq;
    const v = css();
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    // Grid
    g.lineWidth = 1;
    g.font = '9px Inter, system-ui, sans-serif';
    g.fillStyle = v.faint;
    FREQ_LINES.forEach((f) => {
      const x = Math.round(fToX(f, w)) + 0.5;
      g.strokeStyle = v.grid;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
      g.fillText(freqText(f), x + 3, h - 4);
    });
    DB_LINES.forEach((d) => {
      const y = Math.round(gToY(d, h)) + 0.5;
      g.strokeStyle = d === 0 ? v.faint : v.grid;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
      if (d) g.fillText(`${d > 0 ? '+' : ''}${d}`, 3, y - 2);
    });
    // Spectrum of the track (after the EQ)
    const bins = spec.current;
    if (bins?.length) {
      g.beginPath();
      g.moveTo(0, h);
      bins.forEach((db, i) => {
        const x = ((i + 0.5) / bins.length) * w;
        const y = h - Math.max(0, Math.min(1, (db - SPEC_FLOOR) / -SPEC_FLOOR)) * h;
        g.lineTo(x, y);
      });
      g.lineTo(w, h);
      g.closePath();
      g.fillStyle = 'rgba(148, 163, 184, 0.22)';
      g.fill();
    }
    // Curves: the band selected (area), then the whole EQ.
    const n = Math.max(64, Math.round(w / 3));
    const freqs = Array.from({ length: n + 1 }, (_, i) => xToF((i / n) * w, w));
    const y0 = gToY(0, h);
    const sens = k === 'hpf' || k === 'lpf' ? eq[k].on : eq.bands[k].g !== 0;
    if (eq.on && sens) {
      const r = bandResponse(eq, k, freqs);
      g.beginPath();
      g.moveTo(0, y0);
      r.forEach((db, i) => g.lineTo((i / n) * w, Math.max(-2, Math.min(h + 2, gToY(db, h)))));
      g.lineTo(w, y0);
      g.closePath();
      g.globalAlpha = 0.25;
      g.fillStyle = colorOf(k);
      g.fill();
      g.globalAlpha = 1;
    }
    const total = eqResponse(eq, freqs);
    g.beginPath();
    total.forEach((db, i) => {
      const x = (i / n) * w;
      const y = Math.max(-2, Math.min(h + 2, gToY(db, h)));
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.lineWidth = 2;
    g.strokeStyle = eq.on ? s.color || '#f59e0b' : v.faint;
    g.stroke();
    // Points
    KEYS.forEach((key) => {
      const p = pointOf(eq, key, w, h);
      const on = key === 'hpf' || key === 'lpf' ? eq[key].on : true;
      g.beginPath();
      g.arc(p.x, p.y, key === k ? 9 : 7, 0, Math.PI * 2);
      g.fillStyle = on && eq.on ? colorOf(key) : 'rgba(100, 116, 139, 0.6)';
      g.fill();
      if (key === k) {
        g.lineWidth = 2;
        g.strokeStyle = v.text;
        g.stroke();
      }
      g.fillStyle = '#0b0f17';
      g.font = 'bold 9px Inter, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(keyLabel(key), p.x, p.y + 3);
      g.textAlign = 'start';
    });
  };
  const redraw = () => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  };

  // Size (sharp on HiDPI and tablets)
  useEffect(() => {
    const c = canvas.current;
    const ro = new ResizeObserver(() => {
      const r = c.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      size.current = { w: r.width, h: r.height, dpr };
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      redraw();
    });
    ro.observe(c);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Spectrum: polled only while open, the peaks fall slowly; stopped = it fades out.
  useEffect(() => {
    if (strip.index < 0) {
      spec.current = null;
      redraw();
      return undefined;
    }
    let alive = true;
    let busy = false;
    const tick = () => {
      if (busy || document.hidden) return;
      const playing = engineStatus()?.playing;
      if (!playing) {
        if (spec.current) {
          spec.current = spec.current.map((d) => d - 3);
          if (spec.current.every((d) => d < SPEC_FLOOR)) spec.current = null;
          redraw();
        }
        return;
      }
      busy = true;
      engine
        .spectrum(strip.index)
        .then((bins) => {
          if (!alive || !bins?.length) return;
          const prev = spec.current;
          spec.current = prev?.length === bins.length ? bins.map((d, i) => Math.max(d, prev[i] - 2.5)) : bins;
          redraw();
        })
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    };
    const id = setInterval(tick, 50);
    return () => {
      alive = false;
      clearInterval(id);
      engine.spectrum(null).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strip.index]);

  useEffect(redraw);

  const at = (e) => {
    const r = canvas.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const nearest = (p) => {
    const { w, h } = size.current;
    let best = null;
    KEYS.forEach((key) => {
      const q = pointOf(strip.eq, key, w, h);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || d < best.d) best = { key, d };
    });
    return best && best.d < (window.matchMedia('(pointer: coarse)').matches ? 44 : 26) ? best.key : null;
  };
  const move = (key, p, isLive) => {
    const { w, h } = size.current;
    const f = roundF(xToF(p.x, w));
    editEq((eq) => {
      if (key === 'hpf' || key === 'lpf') eq[key].f = f;
      else {
        eq.bands[key].f = f;
        eq.bands[key].g = round(yToG(p.y, h), 1);
      }
    }, isLive);
  };

  const onPointerDown = (e) => {
    if (e.button > 0) return;
    const p = at(e);
    const key = nearest(p);
    if (key === null) return;
    setSel(key);
    if (locked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { key, id: e.pointerId };
    begin();
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    move(d.key, at(e), true);
  };
  const onPointerUp = (e) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const onDoubleClick = (e) => {
    const key = nearest(at(e));
    if (key === null || locked) return;
    editEq((eq) => {
      if (key === 'hpf' || key === 'lpf') eq[key].on = !eq[key].on;
      else eq.bands[key].g = 0;
    });
  };
  // Wheel = width (Q) of the band under the pointer or selected; passive listener can't preventDefault.
  useEffect(() => {
    const c = canvas.current;
    const onWheel = (e) => {
      const { strip: s, sel: k } = live.current;
      if (locked || typeof k !== 'number' || s.eq.bands[k].t !== 'bell') return;
      e.preventDefault();
      const q = s.eq.bands[k].q * (e.deltaY < 0 ? 1.12 : 1 / 1.12);
      editEq((eq) => {
        eq.bands[k].q = round(Math.min(EQ_Q[1], Math.max(EQ_Q[0], q)), 2);
      });
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [locked, editEq]);

  return (
    <canvas
      ref={canvas}
      className={`ch-graph ${locked ? 'is-locked' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      aria-label={`Equalizzatore di ${strip.name}`}
    />
  );
}

function pointOf(eq, key, w, h) {
  if (key === 'hpf' || key === 'lpf') return { x: fToX(eq[key].f, w), y: gToY(0, h) };
  const b = eq.bands[key];
  return { x: fToX(b.f, w), y: gToY(b.g, h) };
}

// One parameter of the band selected: label, slider, value.
function Param({ label, value, text, min, max, step = 1, onChange, onReset, begin, disabled }) {
  return (
    <label className={`ch-param ${disabled ? 'is-disabled' : ''}`}>
      <span className="ch-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onPointerDown={begin} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={onReset} />
      <span className="ch-value">{text}</span>
    </label>
  );
}

export default function ChannelPanel({ strip, state, dispatch, onClose, onStep, begin, dragging }) {
  const [sel, setSel] = useState(2);
  const locked = !state.canEdit;
  const eq = strip.eq;
  // dispatch changes with every render (it closes over the song): always the last one.
  const ref = useRef({ strip, dispatch });
  ref.current = { strip, dispatch };
  // Every change works on a copy of the EQ of the strip as it is now.
  const editEq = useCallback(
    (mut, isLive) => {
      const { strip: s, dispatch: d } = ref.current;
      const next = structuredClone(s.eq);
      mut(next);
      d({ type: 'eq', id: s.id, value: next, live: isLive ?? dragging.current });
    },
    [dragging],
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.target.closest?.('input, select, textarea')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pass = sel === 'hpf' || sel === 'lpf';
  const band = pass ? null : eq.bands[sel];
  const f = pass ? eq[sel].f : band.f;
  const setF = (v) =>
    editEq((e) => {
      if (pass) e[sel].f = v;
      else e.bands[sel].f = v;
    });
  const defaultF = { hpf: 80, lpf: 16000, 0: 100, 1: 300, 2: 1000, 3: 3000, 4: 8000 }[sel];

  return (
    <div className="ch" style={{ '--sec': strip.color }}>
      <div className="ch-head">
        <button className="btn btn-icon btn-sm" onClick={() => onStep(-1)} title="Canale precedente" aria-label="Canale precedente">
          <Icon name="chevron-left" size={15} />
        </button>
        <strong className="ch-name ellipsis" title={strip.name}>
          <i className="ch-dot" />
          {strip.name}
        </strong>
        <button className="btn btn-icon btn-sm" onClick={() => onStep(1)} title="Canale successivo" aria-label="Canale successivo">
          <Icon name="chevron-right" size={15} />
        </button>
        <button
          className={`btn btn-sm ch-toggle ${eq.on ? 'is-on' : ''}`}
          disabled={locked}
          aria-pressed={eq.on}
          onClick={() => editEq((e) => (e.on = !e.on), false)}
          title={eq.on ? 'EQ attivo: clic per escluderlo (confronto)' : 'EQ escluso: clic per riattivarlo'}
        >
          EQ
        </button>
        <button className="btn btn-sm" disabled={locked} onClick={() => dispatch({ type: 'eq', id: strip.id, value: null })} title="Tutte le bande a 0 dB, passa alto e basso spenti">
          Piatto
        </button>
        <span className="grow" />
        {locked && <span className="small faint ellipsis">Solo chi può modificare il brano cambia gain ed EQ</span>}
        <button className="btn btn-icon btn-sm" onClick={onClose} title="Torna al mixer (Esc)" aria-label="Chiudi la sezione canale">
          <Icon name="x" size={15} />
        </button>
      </div>
      <div className="ch-body">
        <div className="ch-gain" title="Gain d'ingresso della traccia, prima dell'EQ (doppio clic: 0 dB)">
          <span className="ch-label">Gain</span>
          <span className="ch-gain-row">
            <input
              className="ch-vslider"
              type="range"
              min={-INPUT_GAIN}
              max={INPUT_GAIN}
              step={0.5}
              value={strip.input}
              disabled={locked}
              onPointerDown={begin}
              onChange={(e) => dispatch({ type: 'input', id: strip.id, value: Number(e.target.value), live: dragging.current })}
              onDoubleClick={() => dispatch({ type: 'input', id: strip.id, value: 0 })}
              aria-label={`Gain di ${strip.name}`}
            />
            {strip.index >= 0 && <Meter track={strip.index} />}
          </span>
          <span className="ch-value">{dbText(strip.input)}</span>
        </div>
        <div className="ch-eq">
          <EqGraph strip={strip} sel={sel} setSel={setSel} editEq={editEq} begin={begin} locked={locked} />
          <div className="ch-controls">
            <span className="ch-keys" role="tablist">
              {KEYS.map((k) => {
                const on = k === 'hpf' || k === 'lpf' ? eq[k].on : eq.bands[k].g !== 0;
                return (
                  <button key={k} role="tab" aria-selected={sel === k} className={`ch-key ${sel === k ? 'is-sel' : ''} ${on ? 'is-on' : ''}`} style={{ '--band': colorOf(k) }} onClick={() => setSel(k)}>
                    {keyLabel(k)}
                  </button>
                );
              })}
            </span>
            {pass ? (
              <button
                className={`btn btn-sm ch-toggle ${eq[sel].on ? 'is-on' : ''}`}
                disabled={locked}
                aria-pressed={eq[sel].on}
                onClick={() => editEq((e) => (e[sel].on = !e[sel].on), false)}
                title={sel === 'hpf' ? 'Passa alto (12 dB/ottava): toglie i bassi sotto la frequenza' : 'Passa basso (12 dB/ottava): toglie gli acuti sopra la frequenza'}
              >
                {sel === 'hpf' ? 'Passa alto' : 'Passa basso'} {eq[sel].on ? 'on' : 'off'}
              </button>
            ) : (
              <select
                className="mx-route ch-type"
                value={band.t}
                disabled={locked}
                onChange={(e) => {
                  editEq((x) => (x.bands[sel].t = e.target.value), false);
                  e.target.blur();
                }}
                aria-label="Tipo di banda"
              >
                {Object.entries(BAND_TYPES).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            )}
            <Param label="Freq" value={fToPos(f)} min={0} max={1000} text={`${freqText(f)} Hz`} onChange={(p) => setF(posToF(p))} onReset={() => setF(defaultF)} begin={begin} disabled={locked} />
            {!pass && (
              <>
                <Param
                  label="Gain"
                  value={band.g}
                  min={-EQ_GAIN}
                  max={EQ_GAIN}
                  step={0.5}
                  text={dbText(band.g)}
                  onChange={(v) => editEq((x) => (x.bands[sel].g = v))}
                  onReset={() => editEq((x) => (x.bands[sel].g = 0), false)}
                  begin={begin}
                  disabled={locked}
                />
                <Param
                  label="Q"
                  value={qToPos(band.q)}
                  min={0}
                  max={1000}
                  text={band.t === 'bell' ? band.q.toFixed(2) : '—'}
                  onChange={(p) => editEq((x) => (x.bands[sel].q = posToQ(p)))}
                  onReset={() => editEq((x) => (x.bands[sel].q = 1), false)}
                  begin={begin}
                  disabled={locked || band.t !== 'bell'}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
