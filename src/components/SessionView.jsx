import { useEffect, useRef } from 'react';
import { formatDuration, isSeparator, PLAYBACK_TYPES } from '../shared/setlists.js';
import { stemsOf } from '../shared/media.js';
import { keyLabel } from '../shared/music.js';
import { engineStatus, livePosition, useEngineStatus } from '../lib/engine';
import { laneKey } from '../lib/lanes';
import { useMediaCache } from '../lib/mediaCache';
import { getMix, useMix } from '../lib/settings';
import Icon from './Icon';
import Meter from './Meter';

const LANE_W = 128;
const MASTER_W = 270;

function SceneProgress() {
  const bar = useRef(null);
  useEffect(() => {
    let raf;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = engineStatus();
      if (bar.current) bar.current.style.width = `${s.duration ? Math.max(0, Math.min(1, livePosition() / s.duration)) * 100 : 0}%`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <span className="scene-progress" ref={bar} />;
}

function cacheLabel(c) {
  if (!c) return <Icon name="cloud" size={11} />;
  if (c.downloading) return c.total ? `${Math.round(((c.received || 0) / c.total) * 100)}%` : '…';
  if (c.error) return '!';
  if (!c.ready) return <Icon name="cloud" size={11} />;
  return null;
}

function Strip({ lane, track, index, solos, onTrack }) {
  if (!track) {
    return (
      <div className="m-strip is-empty" style={{ '--lane-color': lane.color }}>
        <span className="m-name">{lane.name}</span>
        <div className="m-fader-row">
          <input className="fader" type="range" disabled />
        </div>
      </div>
    );
  }
  const { stem } = track;
  const m = getMix(stem.id);
  const gain = m.gainDb ?? stem.gain ?? 0;
  const mute = m.mute ?? !!stem.muted;
  return (
    <div className="m-strip">
      <span className="m-name" style={{ color: lane.color }}>
        {lane.name}
      </span>
      <div className="m-fader-row">
        <input
          className="fader"
          type="range"
          min={-60}
          max={6}
          step={0.5}
          value={gain}
          onChange={(e) => onTrack(stem, { gainDb: Number(e.target.value) })}
          onDoubleClick={() => onTrack(stem, { gainDb: 0 })}
          title="Volume (doppio clic: 0 dB)"
        />
        <Meter track={index} />
      </div>
      <span className="m-db">{gain <= -60 ? '-∞' : `${gain > 0 ? '+' : ''}${gain.toFixed(1)}`} dB</span>
      <div className="m-buttons">
        <button className={`toggle mute ${mute ? 'is-on' : ''}`} onClick={() => onTrack(stem, { mute: !mute })} title="Mute">
          M
        </button>
        <button
          className={`toggle solo ${solos[stem.id] ? 'is-on' : ''}`}
          onClick={() => onTrack(stem, { solo: !solos[stem.id] })}
          title="Solo"
        >
          S
        </button>
      </div>
    </div>
  );
}

export default function SessionView({ items, numbers, lanes, player, selectedId, liveItemId, onSelect, settings, update }) {
  const cache = useMediaCache();
  useMix(); // re-render on local mix changes
  const playingId = useEngineStatus((s) => (s.playing ? s.songId : null));
  const channels = useEngineStatus((s) => s.device?.channels ?? 2);
  const loaded = player.loaded;
  const columns = `${lanes.map(() => `${LANE_W}px`).join(' ')} minmax(24px, 1fr) ${MASTER_W}px`;

  const trackFor = (lane) => {
    const i = loaded?.tracks.findIndex((t) => laneKey(t.stem) === lane.key) ?? -1;
    return i >= 0 ? { track: loaded.tracks[i], index: i } : { track: null, index: -1 };
  };

  return (
    <div className="session">
      <div className="session-inner">
      <div className="session-grid" style={{ gridTemplateColumns: columns }}>
        {lanes.map((l) => (
          <div key={l.key} className="s-head" style={{ '--lane-color': l.color }} title={l.name}>
            <i />
            <span className="ellipsis">{l.name}</span>
          </div>
        ))}
        <div className="s-head" />
        <div className="s-head master">Master · Scene</div>

        {items.map((it) => {
          if (isSeparator(it)) {
            return (
              <div key={it.id} className="s-separator">
                {it.title}
                {it.duration > 0 && <span className="faint">· {formatDuration(it.duration)}</span>}
              </div>
            );
          }
          const stems = stemsOf(it);
          const isLoaded = loaded?.itemId === it.id;
          const isPlaying = playingId === it.id;
          const sel = it.id === selectedId;
          return [
            ...lanes.map((lane) => {
              const stem = stems.find((s) => laneKey(s) === lane.key);
              if (!stem) return <div key={`${it.id}-${lane.key}`} className={`s-cell ${sel ? 'is-selected' : ''}`} onClick={() => onSelect(it.id)} />;
              const c = cache[stem.path];
              const muted = getMix(stem.id).mute ?? !!stem.muted;
              return (
                <div key={`${it.id}-${lane.key}`} className={`s-cell ${sel ? 'is-selected' : ''}`} style={{ '--lane-color': lane.color }}>
                  <button
                    className={`clip ${c?.ready ? '' : 'is-missing'} ${muted ? 'is-muted' : ''} ${isPlaying ? 'is-playing' : ''}`}
                    onClick={() => onSelect(it.id)}
                    onDoubleClick={() => player.launch(it)}
                    title={`${stem.name} — ${stem.file}\nDoppio clic: avvia il brano`}
                  >
                    <span className="tri" />
                    <span className="ellipsis">{stem.name}</span>
                    <span className="cache">{cacheLabel(c)}</span>
                  </button>
                </div>
              );
            }),
            <div key={`${it.id}-fill`} className={`s-cell ${sel ? 'is-selected' : ''}`} onClick={() => onSelect(it.id)} />,
            <div
              key={`${it.id}-scene`}
              className={`s-scene ${isLoaded ? 'is-loaded' : ''} ${it.id === liveItemId ? 'is-live' : ''}`}
              onClick={() => onSelect(it.id)}
              onDoubleClick={() => player.load(it)}
              title="Clic: seleziona · Doppio clic: carica · ▶: avvia"
            >
              <button
                className={`scene-launch ${isPlaying ? 'is-playing' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  player.launch(it);
                }}
                aria-label={isPlaying ? 'Ferma' : 'Avvia brano'}
              >
                <Icon name={isPlaying ? 'stop' : 'play'} size={11} />
              </button>
              <span className="scene-num">{String(numbers[it.id]).padStart(2, '0')}</span>
              <span className="scene-title">
                <strong>{it.title}</strong>
                <span>
                  {[it.bpm && `${it.bpm} BPM`, it.timeSig, it.key && keyLabel(it.key), it.duration && formatDuration(it.duration)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              {it.playback && <span className={`tag tag-play-${it.playback}`}>{PLAYBACK_TYPES[it.playback]?.label}</span>}
              {it.id === liveItemId && <span className="tag tag-live">LIVE</span>}
              {isLoaded && <SceneProgress />}
            </div>,
          ];
        })}

      </div>

      <div className="session-mixer" style={{ gridTemplateColumns: columns }}>
        {lanes.map((lane) => {
          const { track, index } = trackFor(lane);
          return <Strip key={`m-${lane.key}`} lane={lane} track={track} index={index} solos={player.solos} onTrack={player.setTrack} />;
        })}
        <div className="m-strip" />
        <div className="m-strip master">
          <span className="m-name">Click · Master</span>
          <div className="m-fader-row">
            <input
              className="fader"
              type="range"
              min={-60}
              max={6}
              step={0.5}
              value={settings.click.gainDb}
              onChange={(e) => update({ click: { ...settings.click, gainDb: Number(e.target.value) } })}
              title="Volume click"
            />
            <input
              className="fader"
              type="range"
              min={-60}
              max={6}
              step={0.5}
              value={settings.masterDb}
              onChange={(e) => update({ masterDb: Number(e.target.value) })}
              onDoubleClick={() => update({ masterDb: 0 })}
              title="Master tracce"
            />
            <span className="meter" style={{ gap: 3 }}>
              {Array.from({ length: Math.min(8, channels) }, (_, i) => (
                <Meter key={i} output={i} />
              ))}
            </span>
          </div>
          <span className="m-db">
            Click {settings.click.gainDb.toFixed(1)} · Master {settings.masterDb.toFixed(1)} dB
          </span>
          <div className="m-buttons">
            <button
              className={`toggle ${settings.click.enabled ? 'is-on' : ''}`}
              onClick={() => update({ click: { ...settings.click, enabled: !settings.click.enabled } })}
            >
              Click
            </button>
            <button className="toggle" onClick={() => player.stop()} title="Stop (doppio: torna all’inizio)">
              Stop
            </button>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
