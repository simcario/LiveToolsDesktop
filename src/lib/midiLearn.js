// MIDI learn (desktop and tablet): a controller (pedalboard, pads, faders) drives the
// controls of the app. In learn mode (Ctrl+M, or the MIDI learn button) the controls
// that can be assigned light up: click one, then press a key or move a fader on the
// controller and that message is assigned to it. Then the message presses the
// button (or moves the fader) as a click would.
//
// A control is any element with data-midi="<stable id>" (data-midi-name: its name in
// the list; data-midi-press="double" when it acts on a double tap, as the song tiles,
// "dblclick" on a double click event). Two elements may share an id (Play in the
// transport and in the Palco): the first one on screen acts.
// The assignments are kept on this device: settings.midi.map = { [id]: { key, name } }.
// MIDI in comes from midi.rs on the desktop (event "midi-in") and from the plugin
// "midi" on the tablet (plugin event "message").
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { invoke, addPluginListener } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ---------- Messages ----------

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

/** Splits raw bytes (one message, or several as Android sends them) into whole messages; running status kept per port. */
export function splitMessages(bytes, running = { status: 0 }) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b >= 0xf8) {
      i += 1; // clock, start/stop, active sensing: not for learn
      continue;
    }
    if (b === 0xf0) {
      while (i < bytes.length && bytes[i] !== 0xf7) i += 1; // SysEx: skipped
      i += 1;
      continue;
    }
    let status = running.status;
    if (b & 0x80) {
      status = b;
      i += 1;
      if (status >= 0xf0) {
        running.status = 0; // system common: skip its data bytes
        while (i < bytes.length && !(bytes[i] & 0x80)) i += 1;
        continue;
      }
      running.status = status;
    }
    if (!status) {
      i += 1;
      continue;
    }
    const size = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2;
    const data = bytes.slice(i, i + size);
    i += size;
    if (data.length === size) out.push([status, ...data]);
  }
  return out;
}

/**
 * What a message means for learn: { key, kind, value 0-127 }, or null.
 * Notes (on = value > 0), Control Change, Program Change and pitch bend; the key leaves out the value.
 */
export function messageKey([status, d1 = 0, d2 = 0]) {
  const ch = (status & 0x0f) + 1;
  switch (status & 0xf0) {
    case 0x90:
      return { key: `n:${ch}:${d1}`, kind: 'note', value: d2 };
    case 0x80:
      return { key: `n:${ch}:${d1}`, kind: 'note', value: 0 };
    case 0xb0:
      return { key: `c:${ch}:${d1}`, kind: 'cc', value: d2 };
    case 0xc0:
      return { key: `p:${ch}:${d1}`, kind: 'pc', value: 127 };
    case 0xe0:
      return { key: `b:${ch}`, kind: 'bend', value: d2 };
    default:
      return null;
  }
}

/** "Nota C3 · ch 1", "CC 64 · ch 1", "PC 5 · ch 1", "Pitch bend · ch 1". */
export function describeKey(key) {
  const [k, ch, n] = String(key).split(':');
  const num = Number(n);
  if (k === 'n') return `Nota ${noteName(num)} · ch ${ch}`;
  if (k === 'c') return `CC ${num} · ch ${ch}`;
  if (k === 'p') return `PC ${num + 1} · ch ${ch}`;
  if (k === 'b') return `Pitch bend · ch ${ch}`;
  return key;
}

const shortKey = (key) => describeKey(key).replace(' · ch ', '/');

// ---------- Learn mode ----------

let learn = { on: false, selected: null, name: null };
const subs = new Set();
const emit = () => subs.forEach((f) => f());

export function setLearning(on) {
  learn = { on: !!on, selected: null, name: null };
  emit();
}
export const toggleLearning = () => setLearning(!learn.on);
const select = (id, name) => {
  learn = { ...learn, selected: id, name };
  emit();
};

/** { on, selected, name } of the learn mode. */
export function useMidiLearnState() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => learn,
  );
}

const controlName = (el) =>
  (el.dataset.midiName || el.getAttribute('aria-label') || el.title || el.textContent || el.dataset.midi)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .slice(0, 60);

const controlEl = (id) => document.querySelector(`[data-midi="${CSS.escape(id)}"]`);

// The element that acts: the control itself, or the slider / button inside it.
const actor = (el) => (el.matches('input, button, select') ? el : el.querySelector('input[type="range"], button, input') || el);

const setRange = (input, value) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

// Commands without a control always on screen (next song on the tablet): id → function.
const actions = new Map();

/** Registers `fn` as the command `id`, used when no control with that id is on screen. */
export function useMidiAction(id, fn) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const call = () => ref.current();
    actions.set(id, call);
    return () => {
      if (actions.get(id) === call) actions.delete(id);
    };
  }, [id]);
}

/** Presses the control `id` (or moves it, for a fader) as the message `m` says. */
function act(id, m, last) {
  const el = controlEl(id);
  if (!el) {
    const prev = last.get(m.key) ?? 0;
    last.set(m.key, m.value);
    const press = m.kind === 'pc' || (m.kind === 'note' && m.value > 0) || (m.kind === 'cc' && prev < 64 && m.value >= 64);
    if (press && actions.has(id)) actions.get(id)();
    return press;
  }
  const target = actor(el);
  if (target.disabled) return false;
  if (target.matches('input[type="range"]')) {
    if (m.kind !== 'cc' && m.kind !== 'bend') return false;
    const min = Number(target.min || 0);
    const max = Number(target.max || 100);
    const step = Number(target.step) || 1;
    const v = min + ((max - min) * m.value) / 127;
    setRange(target, Math.round(v / step) * step);
    return true;
  }
  // Buttons: a note when pressed, a CC when it crosses the middle going up (a pedal 0 → 127), every PC.
  const prev = last.get(m.key) ?? 0;
  last.set(m.key, m.value);
  const press = m.kind === 'pc' || (m.kind === 'note' && m.value > 0) || (m.kind === 'cc' && prev < 64 && m.value >= 64);
  if (!press) return false;
  if (el.dataset.midiPress === 'dblclick') target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  else if (el.dataset.midiPress === 'double') {
    // A double tap (the song tiles of the Palco load on the second tap).
    target.click();
    target.click();
  } else target.click();
  return true;
}

/** The control assigned to every key that has one. */
export const assignedKeys = (map) => new Map(Object.entries(map || {}).map(([id, a]) => [a.key, id]));

/**
 * MIDI learn and the controls driven by MIDI, mounted once in the main window.
 * Listens to the inputs only when something is assigned or learn mode is on.
 */
export function useMidiControl({ settings, update, notify }) {
  const state = useMidiLearnState();
  const map = settings.midi.map;
  const ctx = useRef({});
  ctx.current = { map, update, notify, state };
  const last = useRef(new Map());

  const active = state.on || Object.keys(map).length > 0;
  const inputs = settings.midi.inputs;
  const inputsKey = JSON.stringify(inputs ?? null);
  useEffect(() => {
    const ports = Array.isArray(inputs) ? inputs : [];
    invoke('midi_listen', { all: active && !Array.isArray(inputs), ports: active ? ports : [] }).catch((e) => {
      if (active) ctx.current.notify?.(`MIDI in: ${e?.message || e}`, true);
    });
    // The inputs as text: the same list in a new array does not open the ports again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, inputsKey]);

  // Messages from the controller.
  useEffect(() => {
    const running = new Map(); // port → running status
    const onBytes = (port, data) => {
      if (!running.has(port)) running.set(port, { status: 0 });
      splitMessages(Array.from(data || []), running.get(port)).forEach((raw) => {
        const m = messageKey(raw);
        if (!m) return;
        const { map: cur, update: up, notify: say, state: st } = ctx.current;
        if (st.on) {
          if (!st.selected) return;
          // Note off and a CC back to 0 do not assign: the key is the one just pressed.
          if (m.kind === 'note' && m.value === 0) return;
          if (cur[st.selected]?.key === m.key) return;
          const next = Object.fromEntries(Object.entries(cur).filter(([, a]) => a.key !== m.key));
          next[st.selected] = { key: m.key, name: st.name };
          up((s) => ({ midi: { ...s.midi, map: next } }));
          say?.(`MIDI learn: “${st.name}” ← ${describeKey(m.key)}`);
          return;
        }
        const id = assignedKeys(cur).get(m.key);
        if (id) act(id, m, last.current);
      });
    };
    const offs = [];
    let alive = true;
    listen('midi-in', (e) => onBytes(e.payload.port, e.payload.data))
      .then((off) => (alive ? offs.push(off) : off()))
      .catch(() => {});
    // Tablet: the plugin event (not there on the desktop).
    Promise.resolve()
      .then(() => addPluginListener('midi', 'message', (p) => onBytes(p.port, p.data)))
      .then((l) => {
        // The Android side knows only removeListener (l.unregister() asks for remove_listener, which is refused).
        const stop = () => invoke('plugin:midi|removeListener', { event: l.event, channelId: l.channelId }).catch(() => {});
        return alive ? offs.push(stop) : stop();
      })
      .catch(() => {});
    return () => {
      alive = false;
      offs.forEach((f) => f());
    };
  }, []);

  // Ctrl+M turns learn mode on and off; Esc leaves it; Canc removes the assignment of the chosen control.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        toggleLearning();
        return;
      }
      const st = ctx.current.state;
      if (!st.on) return;
      if (e.key === 'Escape') setLearning(false);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && st.selected && !e.target.closest?.('input, textarea')) {
        e.preventDefault();
        unassign(ctx.current.update, st.selected);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Learn mode on screen: controls lit, the one chosen, the message on each assigned one.
  useEffect(() => {
    if (!state.on) return undefined;
    document.body.classList.add('midi-learning');
    const pick = (e) => {
      const el = e.target.closest?.('[data-midi]');
      if (!el || e.target.closest('.midi-learn-bar')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'pointerdown') select(el.dataset.midi, controlName(el));
    };
    ['pointerdown', 'click', 'dblclick'].forEach((t) => document.addEventListener(t, pick, true));
    return () => {
      document.body.classList.remove('midi-learning');
      ['pointerdown', 'click', 'dblclick'].forEach((t) => document.removeEventListener(t, pick, true));
    };
  }, [state.on]);

  const mapKey = JSON.stringify(map);
  useEffect(() => {
    if (!state.on) return undefined;
    const paint = () => {
      document.querySelectorAll('[data-midi]').forEach((el) => {
        const a = map[el.dataset.midi];
        if (a) el.setAttribute('data-midi-key', shortKey(a.key));
        else el.removeAttribute('data-midi-key');
        el.classList.toggle('midi-chosen', el.dataset.midi === state.selected);
      });
    };
    paint();
    const obs = new MutationObserver(() => {
      obs.disconnect();
      paint();
      obs.observe(document.body, { childList: true, subtree: true });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      document.querySelectorAll('[data-midi-key], .midi-chosen').forEach((el) => {
        el.removeAttribute('data-midi-key');
        el.classList.remove('midi-chosen');
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.on, state.selected, mapKey]);

  return state;
}

/** Removes the assignment of the control `id`. */
export function unassign(update, id) {
  update((s) => {
    const next = { ...s.midi.map };
    delete next[id];
    return { midi: { ...s.midi, map: next } };
  });
}

/** MIDI inputs: [{ name, listening, error }]. */
export const midiInputs = () => invoke('midi_inputs');
