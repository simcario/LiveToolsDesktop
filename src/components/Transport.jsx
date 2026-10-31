import { useEffect, useState } from 'react';
import { changeTempo } from '../lib/arrange';
import { formatTime, useEngineStatus } from '../lib/engine';
import { downloadProgress, useMediaCache } from '../lib/mediaCache';
import { keyLabel } from '../shared/music.js';
import { TIME_SIGNATURES } from '../shared/setlists.js';
import Icon from './Icon';
import { ZoneToggles } from './Zones';

function Lcd() {
  const bar = useEngineStatus((s) => s.bar);
  const beat = useEngineStatus((s) => s.beat);
  const beats = useEngineStatus((s) => s.beats);
  const pos = useEngineStatus((s) => Math.round(s.position * 10) / 10);
  const dur = useEngineStatus((s) => s.duration);
  const playing = useEngineStatus((s) => s.playing);
  return (
    <div className="lcd" title="Posizione (battuta.movimento) e tempo">
      <span className={`lcd-bars ${bar < 0 ? 'is-count' : ''}`}>
        {bar}.{beat}
      </span>
      <span className="beat-leds" aria-hidden="true">
        {Array.from({ length: Math.min(beats, 12) }, (_, i) => (
          <i key={i} className={`${playing && i + 1 === beat ? 'on' : ''} ${i === 0 ? 'first' : ''}`} />
        ))}
      </span>
      <span className="lcd-time">
        {formatTime(pos)}
        <br />
        <span className="faint">{formatTime(dur)}</span>
      </span>
    </div>
  );
}

// BPM typed on the LCD (Enter / leaving the field applies it, Esc cancels).
function BpmField({ bpm, disabled, onChange }) {
  const shown = bpm ? String(Math.round(bpm * 100) / 100) : '';
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  if (disabled) return <b>{shown || '—'}</b>;
  const commit = () => {
    const v = Number(text.replace(',', '.'));
    if (v >= 20 && v <= 400 && String(Math.round(v * 100) / 100) !== shown) onChange(v);
    else setText(shown);
  };
  return (
    <input
      className="lcd-input"
      value={text}
      inputMode="decimal"
      size={5}
      aria-label="BPM"
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setText(shown);
          setTimeout(() => e.target.blur());
        }
      }}
    />
  );
}

// First load of a song: progress of the files it still has to download.
function DownloadBar({ label, files }) {
  const cache = useMediaCache();
  const percent = Math.round(downloadProgress(files, cache) * 100);
  return (
    <span className="t-download" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span className="small muted ellipsis">{label}</span>
      <span className="bar-progress">
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="small mono">{percent}%</span>
    </span>
  );
}

export default function Transport({ user, item, player, settings, update, canDrive, canEdit, notify, device, onSettings, onPrefs, onHelp, onSignOut, liveOn, page, showViews = true }) {
  const playing = useEngineStatus((s) => s.playing);
  const waiting = useEngineStatus((s) => s.waiting);
  const loaded = player.loaded;
  const tempo = loaded?.tempo?.segments?.find((s) => !s.countIn);
  // Tempo and metre of the song in the player, editable by who may edit it.
  const song = player.loadedItem;
  const editable = !!song && !!tempo && canEdit && song.songEditable !== false;
  const setTempo = (patch) => changeTempo({ song, player, notify }, patch);
  const sig = tempo?.timeSig || song?.timeSig || '4/4';

  return (
    <header className="transport">
      <div className="brand">
        <img src="/brand/logo-mark.png" alt="" />
        <strong>
          Live<span>Tools</span>
        </strong>
      </div>
      <span className="t-sep" />

      <div className="t-group">
        <button className="t-btn" onClick={() => player.step(-1)} title="Brano precedente (←)">
          <Icon name="skip-back" size={16} />
        </button>
        <button
          className={`t-btn play ${playing ? (waiting ? 'is-wait' : 'is-on') : ''}`}
          onClick={() => player.toggle(item)}
          title="Play / Stop (Spazio)"
        >
          <Icon name="play" size={16} />
        </button>
        <button className="t-btn" onClick={() => player.stop()} title="Stop (doppio stop: torna all’inizio)">
          <Icon name="stop" size={14} />
        </button>
        <button className="t-btn" onClick={() => player.step(1)} title="Brano successivo (→)">
          <Icon name="skip-forward" size={16} />
        </button>
      </div>

      <Lcd />

      <div className="lcd" title={editable ? 'Tempo e metro del brano caricato: modificali qui (si salvano con “Salva” nell’Arrangement)' : 'Tempo e metrica del brano caricato'}>
        <span className="lcd-field">
          <BpmField bpm={tempo?.bpm} disabled={!editable} onChange={(bpm) => setTempo({ bpm })} />
          <span>BPM</span>
        </span>
        <span className="lcd-field">
          {editable ? (
            <select className="lcd-input" value={sig} onChange={(e) => setTempo({ timeSig: e.target.value })} aria-label="Metro">
              {[...new Set([sig, ...TIME_SIGNATURES])].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          ) : (
            <b>{tempo?.timeSig || '—'}</b>
          )}
          <span>Metro</span>
        </span>
        <span className="lcd-field">
          <b>{item?.key ? keyLabel(item.key) : '—'}</b>
          <span>Tonalità</span>
        </span>
      </div>

      <div className="t-group">
        <button
          className={`t-btn ${settings.countIn ? 'is-on' : ''}`}
          onClick={() => update({ countIn: !settings.countIn })}
          title="Count-in prima del brano"
        >
          <span className="mono small">1·2</span>
        </button>
        <button
          className={`t-btn ${settings.click.enabled ? 'is-on' : ''}`}
          onClick={() => update({ click: { ...settings.click, enabled: !settings.click.enabled } })}
          title="Click (metronomo) sull’uscita click (C)"
        >
          <Icon name="metronome" size={16} />
        </button>
        <button
          className={`t-btn ${settings.autoAdvance ? 'is-on' : ''}`}
          onClick={() => update({ autoAdvance: !settings.autoAdvance })}
          title="A fine brano prepara il successivo"
        >
          <Icon name="follow" size={16} />
        </button>
      </div>

      <div className="now-playing">
        <strong>{loaded ? item?.title || '—' : 'Nessun brano caricato'}</strong>
        {player.downloading ? (
          <DownloadBar label={player.busy} files={player.downloading} />
        ) : (
          <span className="small muted ellipsis">{player.busy || item?.artist || ' '}</span>
        )}
      </div>

      <div className="t-group">
        <button
          className={`btn btn-sm ${settings.followStage ? 'is-on' : ''}`}
          onClick={() => update({ followStage: !settings.followStage })}
          title="Carica il brano attivato dal master della band (Palco Sync)"
        >
          {liveOn && <span className="dot live" />} Segui palco
        </button>
        {canDrive && (
          <button
            className={`btn btn-sm ${settings.driveStage ? 'is-on' : ''}`}
            onClick={() => update({ driveStage: !settings.driveStage })}
            title="Il brano caricato qui diventa quello attivo per tutta la band"
          >
            <Icon name="radio" size={14} /> Guida
          </button>
        )}
      </div>

      {/* The views (Session, Arrangement, Gobbo, Spartito) belong to the Live page only. */}
      {showViews && (
        <div className="view-switch" role="tablist" aria-label="Vista (Tab)">
          <button className={settings.view === 'session' ? 'is-on' : ''} onClick={() => update({ view: 'session' })}>
            <Icon name="grid" size={14} /> Session
          </button>
          <button
            className={settings.view === 'arrangement' ? 'is-on' : ''}
            onClick={() => update({ view: 'arrangement' })}
          >
            <Icon name="timeline" size={14} /> Arrangement
          </button>
          <button className={settings.view === 'prompter' ? 'is-on' : ''} onClick={() => update({ view: 'prompter' })}>
            <Icon name="lyrics" size={14} /> Gobbo
          </button>
          <button className={settings.view === 'score' ? 'is-on' : ''} onClick={() => update({ view: 'score' })}>
            <Icon name="file-text" size={14} /> Spartito
          </button>
        </div>
      )}

      <ZoneToggles page={page} />

      <button className="device-chip" onClick={onSettings} title="Scheda audio e matrice uscite">
        <span className={`dot ${device?.error ? 'err' : device ? 'ok' : 'warn'}`} />
        <span className="ellipsis">
          {device?.info ? `${device.info.name} · ${device.info.sampleRate / 1000} kHz · ${device.info.channels} out` : 'Audio…'}
        </span>
        <Icon name="settings" size={14} />
      </button>
      <button className="btn btn-ghost btn-icon" onClick={onHelp} title="Manuale (F1)" aria-label="Manuale">
        <Icon name="help" size={16} />
      </button>
      <button className="btn btn-ghost btn-icon" onClick={onPrefs} title="Impostazioni (Ctrl+,)" aria-label="Impostazioni">
        <Icon name="settings" size={16} />
      </button>
      <button className="avatar" onClick={onSignOut} title={`${user.email} — esci`}>
        {user.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : (user.displayName || user.email || '?')[0]}
      </button>
    </header>
  );
}
