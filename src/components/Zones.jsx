import { DEFAULT_SETTINGS, toggleZone, useSettings } from '../lib/settings';
import Icon from './Icon';

// The zones around the main view, as in Cubase: left (Browser), lower (Dettaglio,
// Live page) and right (ispettore, Scaletta and Brani pages). Each one can be
// closed and resized; the limits match the min() of the zone in styles.css.
const ZONES = {
  left: { cssVar: '--browser-w', axis: 'x', sign: 1, min: 180, max: () => window.innerWidth * 0.4 },
  lower: { cssVar: '--detail-h', axis: 'y', sign: -1, min: 120, max: () => window.innerHeight * 0.6 },
  right: { cssVar: '--inspector-w', axis: 'x', sign: -1, min: 300, max: () => window.innerWidth * 0.6 },
};

const TOGGLES = [
  ['left', 'panel-left', 'Browser (Ctrl+Alt+L)'],
  ['lower', 'panel', 'Dettaglio (Ctrl+Alt+E)'],
  ['right', 'panel-right', 'Ispettore (Ctrl+Alt+R)'],
];

/** The CSS variables and classes of the app frame. */
export function zoneFrame(zones) {
  return {
    className: Object.keys(ZONES)
      .filter((k) => !zones[k].open)
      .map((k) => `zone-${k}-closed`)
      .join(' '),
    style: Object.fromEntries(Object.entries(ZONES).map(([k, z]) => [z.cssVar, `${zones[k].size}px`])),
  };
}

// Drag: resizes through the CSS variable only, the setting is saved on release.
// Double click: back to the default size.
export function ZoneResizer({ zone }) {
  const [settings, update] = useSettings();
  const z = ZONES[zone];
  if (!settings.zones[zone].open) return null;
  const save = (size) => update((s) => ({ zones: { ...s.zones, [zone]: { ...s.zones[zone], size } } }));
  const clamp = (v) => Math.round(Math.max(z.min, Math.min(z.max(), v)));
  const at = (e) => (z.axis === 'x' ? e.clientX : e.clientY);

  const start = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const app = handle.closest('.app');
    handle.setPointerCapture(e.pointerId);
    const from = at(e);
    const base = clamp(settings.zones[zone].size);
    let size = base;
    const move = (ev) => {
      size = clamp(base + z.sign * (at(ev) - from));
      app.style.setProperty(z.cssVar, `${size}px`);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      save(size);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  return (
    <div
      className={`zone-resizer zone-resizer-${zone}`}
      role="separator"
      aria-orientation={z.axis === 'x' ? 'vertical' : 'horizontal'}
      title="Trascina per ridimensionare, doppio clic per la misura iniziale"
      onPointerDown={start}
      onDoubleClick={() => save(DEFAULT_SETTINGS.zones[zone].size)}
    />
  );
}

export function ZoneToggles({ page }) {
  const [settings, update] = useSettings();
  // The lower zone exists only on the Live page, the right one only on the others.
  const shown = TOGGLES.filter(([k]) => k === 'left' || (k === 'lower') === (page === 'live'));
  return (
    <div className="t-group" role="group" aria-label="Pannelli">
      {shown.map(([k, icon, label]) => (
        <button
          key={k}
          className={`t-btn ${settings.zones[k].open ? 'is-on' : ''}`}
          onClick={() => update((s) => toggleZone(s, k))}
          aria-pressed={settings.zones[k].open}
          aria-label={label}
          title={label}
        >
          <Icon name={icon} size={16} />
        </button>
      ))}
    </div>
  );
}
