import { useCallback, useEffect, useRef, useState } from 'react';
import { isSeparator } from '../shared/setlists.js';
import { downloadProgress, ensureItems, mediaOf, useMediaCache } from '../lib/mediaCache';
import { CHECKS, overall, runPreflight } from '../lib/preflight';
import { toggleVideoOutput, useOutputOpen } from '../lib/outputs';
import Icon from './Icon';

const HEAD = {
  ok: ['Tutto pronto', 'Si può suonare.'],
  warn: ['Da controllare', 'Si suona, ma qualcosa potrebbe mancare sul palco.'],
  error: ['Problemi da risolvere', 'Risolvi i punti in rosso prima del concerto.'],
};
const DOT = { ok: 'ok', warn: 'warn', error: 'err', skip: '' };

// Controllo pre-concerto (F7): one list with a traffic light, run again by
// itself while the files download. onAudio opens Audio & uscite, onPrefs a
// section of Impostazioni.
export default function PreflightModal({ items, device, settings, net, onAudio, onPrefs, onClose }) {
  const cache = useMediaCache();
  const videoOpen = useOutputOpen('video');
  const [results, setResults] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const run = useRef(0);

  const check = useCallback(() => {
    const id = ++run.current;
    runPreflight({ items, cache, device, settings, videoOpen, net }).then((r) => id === run.current && setResults(r));
  }, [items, cache, device, settings, videoOpen, net]);

  // Again after every change (downloads going on, an interface plugged in), a little later.
  useEffect(() => {
    const t = setTimeout(check, results ? 400 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const songs = items.filter((i) => !isSeparator(i));
  const files = songs.flatMap(mediaOf);
  const progress = downloadProgress(files, cache);

  const download = () => {
    setDownloading(true);
    ensureItems(songs).finally(() => setDownloading(false));
  };

  const ACTIONS = {
    download: ['Scarica tutto', download],
    audio: ['Audio & uscite', onAudio],
    media: ['Cartella dei file', onAudio],
    pedal: ['Pedale', () => onPrefs('pedal')],
    midi: ['MIDI', () => onPrefs('midi')],
    video: ['Apri uscita video', toggleVideoOutput],
  };

  const state = results ? overall(results) : null;
  const [title, sub] = state ? HEAD[state] : ['Controllo in corso…', ''];

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal preflight" role="dialog" aria-modal="true" aria-label="Controllo pre-concerto">
        <div className="modal-head">
          <h2>Controllo pre-concerto</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Chiudi">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className={`preflight-light is-${state || 'busy'}`} role="status">
            <span className="preflight-lamp" aria-hidden="true" />
            <div>
              <strong>{title}</strong>
              {sub && <div className="small muted">{sub}</div>}
            </div>
          </div>
          {downloading && (
            <div className="preflight-progress" aria-label="Download">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
          <ul className="preflight-list">
            {CHECKS.map(([id, label]) => {
              const r = results?.[id];
              const action = r?.action && ACTIONS[r.action];
              return (
                <li key={id} className={r?.status === 'skip' ? 'is-skip' : ''}>
                  <span className={`dot ${r ? DOT[r.status] : ''}`} />
                  <div className="preflight-text">
                    <strong>{label}</strong>
                    <span className="small muted">{r ? r.detail : '…'}</span>
                  </div>
                  {action && (
                    <button className="btn btn-sm" onClick={action[1]} disabled={r.action === 'download' && downloading}>
                      {r.action === 'download' && downloading ? `${Math.round(progress * 100)}%` : action[0]}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="modal-foot">
          <button className="btn btn-sm" onClick={check}>
            <Icon name="repeat" size={14} /> Ricontrolla
          </button>
          <button className="btn btn-sm btn-primary" onClick={onClose} autoFocus>
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}
