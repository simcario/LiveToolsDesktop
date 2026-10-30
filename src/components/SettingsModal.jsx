import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { engine } from '../lib/engine';
import { OUTPUT_ROLES, outputOptions, parseRoute, routeValue } from '../lib/settings';
import Icon from './Icon';
import Meter from './Meter';

const BUFFERS = [null, 64, 128, 256, 512, 1024, 2048];

export default function SettingsModal({ settings, update, device, onClose }) {
  const [devices, setDevices] = useState(null);
  const [mediaDir, setMediaDir] = useState('');
  const channels = device?.info?.channels || 2;
  const asioDrivers = devices?.filter((d) => d.host === 'ASIO');

  useEffect(() => {
    engine.devices().then(setDevices).catch(() => setDevices([]));
    invoke('media_dir').then(setMediaDir).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setOutput = (role, value) => update({ outputs: { ...settings.outputs, [role]: parseRoute(value) } });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Impostazioni audio">
        <div className="modal-head">
          <h2>Audio & uscite</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Chiudi">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="field-row">
            <label className="field">
              <span>Scheda audio</span>
              <select
                className="select"
                value={settings.audioDevice || ''}
                onChange={(e) => update({ audioDevice: e.target.value || null })}
              >
                <option value="">Predefinita di sistema</option>
                {devices
                  ?.filter((d) => d.host !== 'ASIO')
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} · {d.channels} uscite{d.isDefault ? ' (predefinita)' : ''}
                    </option>
                  ))}
                {asioDrivers?.length > 0 && (
                  <optgroup label="ASIO">
                    {asioDrivers.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <label className="field" style={{ maxWidth: 200 }}>
              <span>Buffer</span>
              <select
                className="select"
                value={settings.bufferSize || ''}
                onChange={(e) => update({ bufferSize: Number(e.target.value) || null })}
              >
                {BUFFERS.map((b) => (
                  <option key={b || 'auto'} value={b || ''}>
                    {b ? `${b} campioni` : 'Automatico'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="hint">
            {device?.info
              ? `${device.info.host} · ${device.info.name} · ${device.info.sampleRate} Hz · ${device.info.channels} uscite${device.info.bufferSize ? ` · buffer ${device.info.bufferSize}` : ''}`
              : device?.error || 'Apertura scheda audio…'}
          </p>
          {device?.info?.host === 'ASIO' && (
            <p className="hint">Con ASIO la frequenza di campionamento è quella impostata nel pannello del driver, e di solito nessun altro programma può usare la scheda.</p>
          )}

          <div className="field">
            <span>Matrice uscite (per ruolo delle tracce)</span>
            <div className="matrix">
              {OUTPUT_ROLES.map(([role, label]) => (
                <label key={role} style={{ display: 'contents' }}>
                  <span>{label}</span>
                  <select className="select" value={routeValue(settings.outputs[role])} onChange={(e) => setOutput(role, e.target.value)}>
                    {outputOptions(channels).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <p className="hint">
              Il ruolo di ogni traccia si imposta nell’app web (Sequenze & Video). Il click del metronomo usa l’uscita “Click”.
              Le uscite che la scheda non ha ricadono su Out 1-2.
            </p>
          </div>

          <div className="field">
            <span>Livelli uscite</span>
            <div className="out-meters">
              {Array.from({ length: Math.min(channels, 32) }, (_, i) => (
                <span key={i} className="om">
                  <Meter output={i} />
                  {i + 1}
                </span>
              ))}
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <span>Click & count-in</span>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.click.enabled}
                  onChange={(e) => update({ click: { ...settings.click, enabled: e.target.checked } })}
                />
                Click durante il brano
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.countIn} onChange={(e) => update({ countIn: e.target.checked })} />
                Count-in all’avvio dall’inizio
              </label>
            </div>
            <div className="field">
              <span>Scaletta</span>
              <label className="check">
                <input type="checkbox" checked={settings.autoAdvance} onChange={(e) => update({ autoAdvance: e.target.checked })} />A
                fine brano prepara il successivo
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.followStage} onChange={(e) => update({ followStage: e.target.checked })} />
                Segui il brano attivato dal master (Palco Sync)
              </label>
            </div>
          </div>

          <p className="hint">
            Media scaricati in: <span className="mono">{mediaDir}</span>
          </p>
        </div>
      </div>
    </div>
  );
}
