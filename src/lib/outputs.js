// Output windows (video and gobbo) switched on and off from the main window:
// the same button, or F4 / F6, opens and closes them, so a projector far away
// never needs the mouse. The video opens full screen, on the second screen
// when there is one (the first screen that is not the one of the main window).
import { useSyncExternalStore } from 'react';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, currentMonitor, PhysicalPosition } from '@tauri-apps/api/window';

const TITLES = { video: 'Uscita video', prompter: 'Gobbo' };
let open = { video: false, prompter: false };
const listeners = new Set();
const setOpen = (label, on) => {
  if (open[label] === on) return;
  open = { ...open, [label]: on };
  listeners.forEach((f) => f());
};
const watch = (win, label) => win.once('tauri://destroyed', () => setOpen(label, false)).catch(() => {});

// Windows already open (the main window reloaded).
Object.keys(TITLES).forEach((label) =>
  WebviewWindow.getByLabel(label)
    .then((w) => {
      if (!w) return;
      setOpen(label, true);
      watch(w, label);
    })
    .catch(() => {}),
);

async function create(label) {
  setOpen(label, true);
  let target = null;
  if (label === 'video') {
    const [all, here] = await Promise.all([availableMonitors().catch(() => []), currentMonitor().catch(() => null)]);
    const same = (m) => here && m.position.x === here.position.x && m.position.y === here.position.y;
    target = all.find((m) => !same(m)) || here;
  }
  const win = new WebviewWindow(label, { url: `index.html?view=${label}`, title: `LiveTools · ${TITLES[label]}`, width: 960, height: 540 });
  watch(win, label);
  win.once('tauri://error', () => setOpen(label, false));
  if (label !== 'video') return;
  win.once('tauri://created', async () => {
    try {
      if (target) await win.setPosition(new PhysicalPosition(target.position.x + 40, target.position.y + 40));
      await win.setFullscreen(true);
    } catch {
      // it stays a normal window
    }
  });
}

/** Opens the output window, or closes it when it is open. */
const creating = new Set();
export async function toggleOutput(label) {
  if (creating.has(label)) return; // still opening: a second press is ignored
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    setOpen(label, false);
    await existing.close().catch(() => {});
    return;
  }
  creating.add(label);
  try {
    await create(label);
  } finally {
    creating.delete(label);
  }
}

export const toggleVideoOutput = () => toggleOutput('video');
export const togglePrompterOutput = () => toggleOutput('prompter');

/** Whether the output window is open (for the pressed state of its button). */
export const useOutputOpen = (label) =>
  useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => open[label],
  );
