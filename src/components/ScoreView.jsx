import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getBytes, ref } from 'firebase/storage';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { safeUrl } from '../shared/setlists.js';
import { keyLabel, PEDAL_LAYOUTS, scoreOf, useScoreViewer } from '../shared/score.js';
import { storage } from '../lib/firebase';
import { ensureFile } from '../lib/mediaCache';
import { pedalDevice, useBluetoothDevices } from '../lib/pedal';
import Icon from './Icon';

// "Spartito" view of the Live page: the PDF score of the selected song, one
// or two pages at a time, turned with a Bluetooth pedal (it sends keys, see
// shared/score.js), the keyboard or a click on the page. The PDF is played
// from the local cache like the stems, so it works offline on stage.

/** Bytes of the score: from the cache (downloaded once), else straight from Storage. */
async function scoreBytes(score) {
  const local = await ensureFile({ path: score.path, size: score.size });
  if (local) {
    try {
      const res = await fetch(convertFileSrc(local));
      if (res.ok) return await res.arrayBuffer();
    } catch {
      // read it from Storage below
    }
  }
  return getBytes(ref(storage, score.path));
}

function Canvas({ canvas }) {
  const host = useRef(null);
  useLayoutEffect(() => {
    const el = host.current;
    el.replaceChildren(canvas);
  }, [canvas]);
  return <div className="sc-page" ref={host} />;
}

/** Name of the connected pedal, lighting up at every press. */
export function PedalChip({ lastPedal, onClick }) {
  const { devices } = useBluetoothDevices();
  const device = pedalDevice(devices);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!lastPedal) return undefined;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 350);
    return () => clearTimeout(t);
  }, [lastPedal]);
  return (
    <button
      className={`sc-pedal ${device ? 'is-on' : ''} ${flash ? 'is-flash' : ''}`}
      onClick={onClick}
      title={
        device
          ? `Pedale collegato: ${device.name}${lastPedal ? ` · ultimo tasto ${keyLabel(lastPedal.key)}` : ''}. Impostazioni del pedale…`
          : 'Nessun dispositivo Bluetooth di input collegato. Impostazioni del pedale…'
      }
    >
      <span className="sc-dot" />
      {device ? device.name : 'Nessun pedale'}
      {lastPedal && <span className="mono sc-key">{keyLabel(lastPedal.key)}</span>}
    </button>
  );
}

export default function ScoreView({ item, settings, update, onPedalPrefs, active }) {
  const score = scoreOf(item);
  const chartUrl = safeUrl(item?.chartUrl);

  if (!item) return <div className="empty">Seleziona un brano della scaletta.</div>;
  if (!score) {
    return (
      <div className="empty">
        <div>
          <Icon name="file-text" size={28} />
          <h2>Nessuno spartito PDF</h2>
          <p>
            Caricalo nella pagina <b>Scaletta</b> o <b>Brani</b>, scheda <b>Sequenze, Video &amp; PDF</b>: qui lo sfogli con il
            pedale.
          </p>
          {chartUrl && (
            <button className="btn btn-sm" onClick={() => openUrl(chartUrl)}>
              <Icon name="file-text" size={14} /> Apri il link dello spartito
            </button>
          )}
        </div>
      </div>
    );
  }
  return <Viewer key={score.path} item={item} score={score} settings={settings} update={update} onPedalPrefs={onPedalPrefs} active={active} />;
}

function Viewer({ item, score, settings, update, onPedalPrefs, active }) {
  const box = useRef(null);
  const [full, setFull] = useState(false);
  const pedal = settings.pedal;
  const load = useCallback(() => scoreBytes(score), [score]);
  const v = useScoreViewer({ load, loadKey: score.path, workerSrc, pedal, active, boxRef: box });

  // Esc leaves full screen; Home / End jump to the first / last page.
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      if (e.key === 'Escape' && full) setFull(false);
      else if (e.key === 'End') v.goto(v.count);
      // Home also rewinds the player: the score goes back to page 1 with it.
      else if (e.key === 'Home') v.goto(1);
      else if (e.key === 'F11') {
        e.preventDefault();
        setFull((f) => !f);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, full, v]);

  const onPage = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    v.go(e.clientX - r.left < r.width * 0.3 ? -1 : 1);
  };

  return (
    <div className={`score ${full ? 'is-full' : ''}`}>
      <div className="arr-toolbar">
        <strong className="ellipsis">{item.title}</strong>
        <span className="small muted ellipsis" title={score.file}>
          {score.file}
        </span>
        <span className="t-sep" style={{ height: 18 }} />
        <button className="btn btn-sm btn-icon" onClick={() => v.go(-1)} disabled={v.page <= 1} title="Pagina precedente (pedale sinistro)">
          <Icon name="chevron-up" size={14} />
        </button>
        <span className="mono small sc-count">
          {v.count ? (v.double && v.page < v.count ? `${v.page}-${v.page + 1}` : v.page) : '–'} / {v.count || '–'}
        </span>
        <button
          className="btn btn-sm btn-icon"
          onClick={() => v.go(1)}
          disabled={!v.count || v.page + (v.double ? 1 : 0) >= v.count}
          title="Pagina successiva (pedale destro)"
        >
          <Icon name="chevron-down" size={14} />
        </button>
        <select
          className="select"
          value={pedal.layout}
          onChange={(e) => update({ pedal: { ...pedal, layout: e.target.value } })}
          title="Pagine affiancate: “Automatico” ne mostra due quando lo schermo è largo"
        >
          {PEDAL_LAYOUTS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <span className="grow" />
        <PedalChip lastPedal={v.lastPedal} onClick={onPedalPrefs} />
        <button className="btn btn-sm btn-icon" onClick={() => setFull((f) => !f)} title={full ? 'Esci da schermo intero (Esc)' : 'Schermo intero (F11)'}>
          <Icon name={full ? 'x' : 'maximize'} size={14} />
        </button>
      </div>
      <div className={`sc-body ${v.double ? 'is-double' : ''}`} ref={box} onClick={onPage}>
        {v.status === 'loading' && <span className="sc-msg">Carico lo spartito…</span>}
        {v.status === 'error' && <span className="sc-msg is-error">Spartito non leggibile: {v.error}</span>}
        {v.status === 'ready' && v.spread.map((c, i) => <Canvas key={i} canvas={c} />)}
      </div>
    </div>
  );
}
