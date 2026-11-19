import { useEffect, useState } from 'react';
import { changeTempo } from '../lib/arrange';
import { formatTime, useBeatDisplay, useEngineStatus } from '../lib/engine';
import { downloadProgress, useMediaCache } from '../lib/mediaCache';
import { keyLabel } from '../shared/music.js';
import { TIME_SIGNATURES } from '../shared/setlists.js';
import Icon from './Icon';
import Toolbar, { ToolGroup } from './Toolbar';
import { ZoneToggles } from './Zones';
import { toggleLearning, useMidiLearnState } from '../lib/midiLearn';
import { rttText } from '../lib/stageNet';
import BandPanel from './BandPanel';

// Who is on the local network of the stage, for the tooltips.
const peersText = (peers) => peers.map((p) => `${p.name}${p.part ? ` (${p.part})` : ''} · ${rttText(p.rtt)}`).join('\n');

function Lcd() {
  // bar.beat and the leds are written by useBeatDisplay in the frame of the beat.
  const { beats, leds, text } = useBeatDisplay();
  const pos = useEngineStatus((s) => Math.round(s.position * 10) / 10);
  const dur = useEngineStatus((s) => s.duration);
  return (
    <div className="lcd" title="Posizione (battuta.movimento) e tempo">
      <span className="lcd-bars" ref={text} />
      <span className="beat-leds" aria-hidden="true" ref={leds}>
        {Array.from({ length: Math.min(beats, 12) }, (_, i) => (
          <i key={i} className={i === 0 ? 'first' : undefined} />
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

export default function Transport({ user, item, player, settings, update, canDrive, canEdit, notify, device, onSettings, onPrefs, onHelp, onPreflight, onSignOut, liveOn, page, showViews = true, stage = false, net = null, band = null, setlist = null }) {
  const playing = useEngineStatus((s) => s.playing);
  const waiting = useEngineStatus((s) => s.waiting);
  const learning = useMidiLearnState().on;
  const loaded = player.loaded;
  const tempo = loaded?.tempo?.segments?.find((s) => !s.countIn);
  // Tempo and metre of the song in the player, editable by who may edit it.
  const song = player.loadedItem;
  const editable = !!song && !!tempo && canEdit && song.songEditable !== false;
  const setTempo = (patch) => changeTempo({ song, player, notify }, patch);
  const sig = tempo?.timeSig || song?.timeSig || '4/4';

  return (
    <Toolbar as="header" id="transport" title="principale" className="transport">
      <ToolGroup id="brand" label="Logo">
        <div className="brand">
          <img src="/brand/logo-mark.png" alt="" />
          <strong>
            Live<span>Tools</span>
          </strong>
        </div>
      </ToolGroup>
      <ToolGroup id="transport" label="Trasporto" locked>
        <div className="t-group">
          <button className="t-btn" onClick={() => player.step(-1)} title="Brano precedente (←)" data-midi="transport.prev">
            <Icon name="skip-back" size={16} />
          </button>
          <button className="t-btn" onClick={() => player.locate(0)} disabled={!player.loaded} title="Torna all’inizio del brano (Home)" aria-label="Torna all’inizio del brano" data-midi="transport.start" data-midi-name="Torna all’inizio">
            <Icon name="to-start" size={16} />
          </button>
          <button
            className={`t-btn play ${playing ? (waiting ? 'is-wait' : 'is-on') : ''}`}
            onClick={() => player.toggle(item)}
            title="Play / Stop (Spazio)"
            data-midi="transport.play"
          >
            <Icon name="play" size={16} />
          </button>
          <button className="t-btn" onClick={() => player.stop()} title="Stop (doppio stop: torna all’inizio)" data-midi="transport.stop" data-midi-name="Stop">
            <Icon name="stop" size={14} />
          </button>
          <button className="t-btn" onClick={() => player.step(1)} title="Brano successivo (→)" data-midi="transport.next">
            <Icon name="skip-forward" size={16} />
          </button>
        </div>
      </ToolGroup>
      <ToolGroup id="position" label="Posizione" locked>
        <Lcd />
      </ToolGroup>
      <ToolGroup id="tempo" label="Tempo">
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
      </ToolGroup>
      <ToolGroup id="playback" label="Esecuzione">
        <div className="t-group">
          <button
            className={`t-btn ${settings.countIn ? 'is-on' : ''}`}
            onClick={() => update({ countIn: !settings.countIn })}
            title="Count-in prima del brano"
            data-midi="transport.countIn"
          >
            <span className="mono small">1·2</span>
          </button>
          <button
            className={`t-btn ${settings.click.enabled ? 'is-on' : ''}`}
            onClick={() => update({ click: { ...settings.click, enabled: !settings.click.enabled } })}
            title="Click (metronomo) sull’uscita click (C)"
            data-midi="transport.click"
            data-midi-name="Click"
          >
            <Icon name="metronome" size={16} />
          </button>
          <button
            className={`t-btn ${settings.click.eighths ? 'is-on' : ''}`}
            onClick={() => update({ click: { ...settings.click, eighths: !settings.click.eighths } })}
            title="Click in ottavi: raddoppia i battiti nei tempi semplici (Maiusc+C)"
            data-midi="transport.eighths"
            data-midi-name="Click in ottavi"
          >
            <span className="mono small">×2</span>
          </button>
          <button
            className={`t-btn ${settings.autoAdvance ? 'is-on' : ''}`}
            onClick={() => update({ autoAdvance: !settings.autoAdvance })}
            title="A fine brano prepara il successivo"
            data-midi="transport.autoAdvance"
          >
            <Icon name="follow" size={16} />
          </button>
        </div>
      </ToolGroup>
      <ToolGroup id="song" label="Brano" grow>
        <div className="now-playing">
          <strong>{loaded ? item?.title || '—' : 'Nessun brano caricato'}</strong>
          {player.downloading ? (
            <DownloadBar label={player.busy} files={player.downloading} />
          ) : (
            <span className="small muted ellipsis">{player.busy || item?.artist || ' '}</span>
          )}
        </div>
      </ToolGroup>
      <ToolGroup id="band" label="Band">
        <div className="t-group">
          <button
            className={`btn btn-sm ${settings.followStage ? 'is-on' : ''}`}
            onClick={() => update({ followStage: !settings.followStage })}
            title="Carica il brano attivato dal master della band (Palco Sync)"
            data-midi="band.follow"
            data-midi-name="Segui palco"
          >
            {liveOn && <span className="dot live" />} Segui palco
            {settings.followStage && settings.stageNet.backup && (
              <span className="t-lan t-backup" title="Computer di riserva: suona insieme a chi guida (Impostazioni › Rete locale)">
                RISERVA
              </span>
            )}
            {settings.followStage && net?.connected && (
              <span className="t-lan" title={`Rete locale: collegato a ${net.host?.name || net.joined} · ${rttText(net.rtt)}${net.peers.length ? `\nIn rete:\n${peersText(net.peers)}` : ''}`}>
                LAN
              </span>
            )}
          </button>
          {canDrive && (
            <button
              className={`btn btn-sm ${settings.driveStage ? 'is-on' : ''}`}
              onClick={() => update({ driveStage: !settings.driveStage })}
              title="Il brano caricato qui diventa quello attivo per tutta la band"
              data-midi="band.drive"
              data-midi-name="Guida la band"
            >
              <Icon name="radio" size={14} /> Guida
              {settings.driveStage && net?.hosting && (
                <span className="t-lan" title={net.peers.length ? `Rete locale, in ascolto:\n${peersText(net.peers)}` : 'Rete locale attiva: nessuno collegato'}>
                  LAN {net.peers.length}
                </span>
              )}
            </button>
          )}
          {band && setlist && <BandPanel band={band} setlist={setlist} canDrive={canDrive} notify={notify} />}
        </div>
      </ToolGroup>
      {/* The views (Palco, Arrangement, Gobbo, Spartito) belong to the Live page only. */}
      {showViews && (
        <ToolGroup id="views" label="Viste" locked>
          <div className="view-switch" role="tablist" aria-label="Vista (Tab)">
            <button className={settings.view === 'stage' ? 'is-on' : ''} onClick={() => update({ view: 'stage' })} data-midi="view.stage" data-midi-name="Vista Palco">
              <Icon name="grid" size={14} /> Palco
            </button>
            <button
              className={settings.view === 'arrangement' ? 'is-on' : ''}
              onClick={() => update({ view: 'arrangement' })}
              data-midi="view.arrangement"
              data-midi-name="Vista Arrangement"
            >
              <Icon name="timeline" size={14} /> Arrangement
            </button>
            <button className={settings.view === 'prompter' ? 'is-on' : ''} onClick={() => update({ view: 'prompter' })} data-midi="view.prompter" data-midi-name="Vista Gobbo">
              <Icon name="lyrics" size={14} /> Gobbo
            </button>
            <button className={settings.view === 'score' ? 'is-on' : ''} onClick={() => update({ view: 'score' })} data-midi="view.score" data-midi-name="Vista Spartito">
              <Icon name="file-text" size={14} /> Spartito
            </button>
          </div>
        </ToolGroup>
      )}
      {/* Palco has no panels around it. */}
      {!stage && (
        <ToolGroup id="panels" label="Pannelli">
          <ZoneToggles page={page} />
        </ToolGroup>
      )}
      <ToolGroup id="audio" label="Audio">
        <button className="device-chip" onClick={onSettings} title="Scheda audio e matrice uscite">
          <span className={`dot ${device?.error ? 'err' : device ? 'ok' : 'warn'}`} />
          <span className="ellipsis">
            {device?.info ? `${device.info.name} · ${device.info.sampleRate / 1000} kHz · ${device.info.channels} out` : 'Audio…'}
          </span>
          <Icon name="settings" size={14} />
        </button>
      </ToolGroup>
      <ToolGroup id="app" label="App" locked corner>
        <button
          className={`btn btn-ghost btn-icon ${learning ? 'is-on' : ''}`}
          onClick={toggleLearning}
          aria-pressed={learning}
          title="MIDI learn: collega tasti e fader di un controller ai comandi (Ctrl+M)"
          aria-label="MIDI learn"
        >
          <Icon name="music" size={16} />
        </button>
        {onPreflight && (
          <button className="btn btn-ghost btn-icon" onClick={onPreflight} title="Controllo pre-concerto: file, audio, MIDI, pedale, disco (F7)" aria-label="Controllo pre-concerto">
            <Icon name="check" size={16} />
          </button>
        )}
        <button className="btn btn-ghost btn-icon" onClick={onHelp} title="Manuale (F1)" aria-label="Manuale">
          <Icon name="help" size={16} />
        </button>
        <button className="btn btn-ghost btn-icon" onClick={onPrefs} title="Impostazioni (Ctrl+,)" aria-label="Impostazioni">
          <Icon name="settings" size={16} />
        </button>
        <button className="avatar" onClick={onSignOut} title={`${user.email} — esci`}>
          {user.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : (user.displayName || user.email || '?')[0]}
        </button>
      </ToolGroup>
    </Toolbar>
  );
}
