// Context menus: right click on the computer, a long press on tablets and phones.
//
// A component opens one from its own onContextMenu:
//   onContextMenu={(e) => openContextMenu(e, [{ label, icon, onSelect, disabled, danger, checked, hint, keys }, '-', …], { title })}
// Falsy entries are skipped (`cond && {…}`), separators ('-') never double up.
//
// <ContextMenuHost/> (mounted once, in main.jsx) draws the menu and turns a long press of a
// finger into a `contextmenu` event on the element under it, so the same handler serves both.
// Copied to the mobile app by sync-desktop: keep it free of desktop-only modules.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

const LONG_PRESS = 480; // ms of a still finger that open the menu
const SLOP = 10; // px a finger can wander during the long press
const AFTER = 700; // ms after a long press in which the click and the tap it would make are ignored

let menu = null; // { x, y, items, title, touch }
const subs = new Set();
const emit = () => subs.forEach((f) => f());
const setMenu = (m) => {
  menu = m;
  emit();
};
const subscribe = (f) => {
  subs.add(f);
  return () => subs.delete(f);
};

let pressedAt = 0; // when a long press last opened a menu
let lastTouchAt = 0; // last touch or pen pointerdown (native long-press menus come after it)

/** True just after a long press opened a menu: the lifted finger is not a tap. */
export const longPressed = () => performance.now() - pressedAt < AFTER;

const clean = (items) => {
  const out = [];
  items.forEach((it) => {
    if (!it) return;
    if (it === '-') {
      if (out.length && out.at(-1) !== '-') out.push('-');
    } else out.push(it);
  });
  while (out.at(-1) === '-') out.pop();
  return out;
};

/** Opens a menu where the event happened. Returns false (and lets the event go) when there is nothing to show. */
export function openContextMenu(e, items, { title } = {}) {
  const list = clean(items);
  if (!list.length) return false;
  e.preventDefault();
  e.stopPropagation();
  const native = e.nativeEvent || e;
  setMenu({ x: e.clientX, y: e.clientY, items: list, title, touch: !!native.ltLongPress });
  return true;
}

export const closeContextMenu = () => setMenu(null);

const editable = (el) => !!el?.closest?.('input, textarea, select, [contenteditable="true"]');

function useLongPress() {
  useEffect(() => {
    let press = null; // { x, y, target, at, timer, ended }
    const fire = () => {
      if (!press) return;
      const { x, y, target } = press;
      clearTimeout(press.timer);
      press = null;
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 });
      ev.ltLongPress = true;
      target.dispatchEvent(ev);
      if (ev.defaultPrevented) {
        pressedAt = performance.now();
        navigator.vibrate?.(12);
      }
    };
    const cancel = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    // The system can cancel the pointer for its own long press (Android WebView) just before
    // sending its contextmenu: the press is kept a moment for it (see `native`).
    const interrupted = () => {
      if (!press) return;
      clearTimeout(press.timer);
      press.ended = performance.now();
    };
    const down = (e) => {
      if (e.pointerType === 'mouse') return;
      lastTouchAt = performance.now();
      pressedAt = 0; // a new touch: the next click is a real one
      cancel();
      if (!e.isPrimary || editable(e.target)) return;
      press = { x: e.clientX, y: e.clientY, target: e.target, at: performance.now(), timer: setTimeout(fire, LONG_PRESS) };
    };
    const move = (e) => {
      if (press && !press.ended && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) cancel();
    };
    // The menu of the browser for a long press (Android) or a right click: ours or none,
    // but inside text fields the one of the system (copy, paste) stays.
    const native = (e) => {
      if (e.ltLongPress || editable(e.target)) return;
      const now = performance.now();
      // Right after a touch it is the long press of the system: ours takes its place.
      if (now - lastTouchAt < 1500) {
        e.preventDefault();
        e.stopPropagation();
        if (press && now - press.at > 250 && (!press.ended || now - press.ended < 300)) fire();
      }
    };
    const fallback = (e) => {
      if (!e.defaultPrevented && !editable(e.target) && !(import.meta.env.DEV && e.ctrlKey)) e.preventDefault();
    };
    const swallow = (e) => {
      if (longPressed()) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', cancel, true);
    window.addEventListener('pointercancel', interrupted, true);
    window.addEventListener('scroll', cancel, true);
    window.addEventListener('contextmenu', native, true);
    window.addEventListener('contextmenu', fallback);
    window.addEventListener('click', swallow, true);
    window.addEventListener('dblclick', swallow, true);
    return () => {
      cancel();
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', cancel, true);
      window.removeEventListener('pointercancel', interrupted, true);
      window.removeEventListener('scroll', cancel, true);
      window.removeEventListener('contextmenu', native, true);
      window.removeEventListener('contextmenu', fallback);
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('dblclick', swallow, true);
    };
  }, []);
}

function Menu({ m }) {
  const box = useRef(null);
  const [pos, setPos] = useState({ left: m.x, top: m.y, ready: false });
  const [hot, setHot] = useState(-1);
  const enabled = m.items.map((it, i) => (it !== '-' && !it.disabled ? i : -1)).filter((i) => i >= 0);

  // Inside the window; on a touch screen a little away from the finger.
  useLayoutEffect(() => {
    const r = box.current.getBoundingClientRect();
    const pad = 8;
    const dx = m.touch ? 12 : 2;
    let left = m.x + dx;
    let top = m.y + (m.touch ? -r.height / 3 : 2);
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, m.x - r.width - dx);
    top = Math.max(pad, Math.min(top, window.innerHeight - r.height - pad));
    setPos({ left, top, ready: true });
    box.current.focus({ preventScroll: true });
  }, [m]);

  const pick = (it) => {
    if (it.disabled) return;
    setMenu(null);
    it.onSelect?.();
  };

  // The keys belong to the menu while it is open (Space and Enter never reach the transport).
  const keys = useRef();
  keys.current = (e) => {
    if (e.key === 'Escape') setMenu(null);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!enabled.length) return;
      const at = enabled.indexOf(hot);
      setHot(e.key === 'ArrowDown' ? enabled[(at + 1) % enabled.length] : enabled[(at - 1 + enabled.length) % enabled.length]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (hot >= 0) pick(m.items[hot]);
    } else if (e.key !== 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
  };
  useEffect(() => {
    const onKey = (e) => keys.current(e);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div
      className={`ctx-backdrop ${m.touch ? 'is-touch' : ''}`}
      onPointerDown={(e) => e.target === e.currentTarget && setMenu(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (e.target === e.currentTarget) setMenu(null);
      }}
      onWheel={() => setMenu(null)}
    >
      <div className="ctx-menu" ref={box} role="menu" tabIndex={-1} style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}>
        {m.title && <div className="ctx-title ellipsis">{m.title}</div>}
        {m.items.map((it, i) =>
          it === '-' ? (
            <div key={i} className="ctx-sep" role="separator" />
          ) : (
            <button
              key={i}
              type="button"
              role={it.checked != null ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={it.checked != null ? !!it.checked : undefined}
              className={`ctx-item ${it.danger ? 'is-danger' : ''} ${hot === i ? 'is-hot' : ''}`}
              disabled={it.disabled}
              onPointerEnter={() => setHot(i)}
              onClick={() => pick(it)}
              title={it.title}
            >
              <span className="ctx-icon">{it.checked ? <Icon name="check" size={14} /> : it.icon ? <Icon name={it.icon} size={14} /> : null}</span>
              <span className="ctx-label">
                {it.label}
                {it.hint && <small>{it.hint}</small>}
              </span>
              {it.keys && <kbd className="ctx-keys">{it.keys}</kbd>}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

export function ContextMenuHost() {
  useLongPress();
  const m = useSyncExternalStore(subscribe, () => menu);
  useEffect(() => {
    if (!m) return undefined;
    const close = () => setMenu(null);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [m]);
  return m ? createPortal(<Menu key={`${m.x},${m.y}`} m={m} />, document.body) : null;
}
