import { formatDuration, PLAYBACK_TYPES } from '../shared/setlists.js';
import { formatBytes, groupLabel, rehearsalGroup, rehearsalGroups, STEM_ROLES, stemsOf, videoOf } from '../shared/media.js';
import { keyLabel } from '../shared/music.js';
import { ensureItems, useMediaCache } from '../lib/mediaCache';
import { laneColor, ROLE_COLORS } from '../lib/lanes';
import Icon from './Icon';
import SyncControl from './SyncControl';
import SyncedVideo from './SyncedVideo';

export function CacheState({ c }) {
  if (!c) return <span className="small faint">—</span>;
  if (c.downloading) {
    return (
      <span className="small mono" style={{ color: 'var(--cyan)' }}>
        {c.total ? `${Math.round(((c.received || 0) / c.total) * 100)}%` : '…'}
      </span>
    );
  }
  if (c.error) return <span className="small" style={{ color: 'var(--danger)' }} title={c.error}>Errore</span>;
  if (c.ready) return <Icon name="check" size={13} style={{ color: 'var(--yes)' }} />;
  return <Icon name="cloud" size={13} style={{ color: 'var(--faint)' }} />;
}

export default function DetailView({ item, number, lanes, player, onVideoOutput }) {
  const cache = useMediaCache();
  const loaded = player.loaded;

  if (!item) {
    return (
      <section className="detail">
        <div className="d-col" style={{ gridColumn: '1 / -1' }}>
          <div className="empty">Seleziona un brano della scaletta.</div>
        </div>
      </section>
    );
  }
  const stems = stemsOf(item);
  const video = videoOf(item);
  const isLoaded = loaded?.itemId === item.id;
  const sections = (item.sections || []).filter((s) => s.label || s.bars);
  // The click group exists even without a click stem: the engine's metronome.
  const groups = rehearsalGroups(item);
  if (stems.length && !groups.includes('click')) groups.splice(groups.length - (groups.includes('guide') ? 1 : 0), 0, 'click');
  const missing = [...stems, ...(video ? [video] : [])].some((m) => !cache[m.path]?.ready);

  return (
    <section className="detail">
      <div className="d-col">
        <div className="panel-head">
          Brano {number ? `#${String(number).padStart(2, '0')}` : ''}
          {isLoaded && <span className="tag tag-play-backing">Nel player</span>}
        </div>
        <div className="d-body">
          <h2 className="d-title">{item.title}</h2>
          <div className="small muted">
            {[item.artist, item.genre].filter(Boolean).join(' · ')}{' '}
            {item.playback && <span className={`tag tag-play-${item.playback}`}>{PLAYBACK_TYPES[item.playback]?.label}</span>}
          </div>
          <div className="d-tiles">
            <div className="d-tile">
              <span>BPM</span>
              <b>{item.bpm || '—'}</b>
            </div>
            <div className="d-tile">
              <span>Tonalità</span>
              <b>{item.key ? keyLabel(item.key) : '—'}</b>
            </div>
            <div className="d-tile">
              <span>Metro</span>
              <b>{item.timeSig || '4/4'}</b>
            </div>
            <div className="d-tile">
              <span>Durata</span>
              <b>{item.duration ? formatDuration(item.duration) : '—'}</b>
            </div>
          </div>
          <div className="d-actions">
            <button className="btn btn-primary btn-sm" onClick={() => player.launch(item)}>
              <Icon name="play" size={13} /> Avvia
            </button>
            <button className="btn btn-sm" onClick={() => player.load(item)}>
              Carica
            </button>
            {missing && (
              <button className="btn btn-sm" onClick={() => ensureItems([item])}>
                <Icon name="download" size={14} /> Scarica media
              </button>
            )}
          </div>
          {isLoaded && (
            <div style={{ marginTop: 10 }}>
              <SyncControl player={player} compact />
            </div>
          )}
          {sections.length > 0 && (
            <div className="d-sections">
              {sections.map((s, i) => (
                <span key={i} className="tag">
                  {s.label || `Sezione ${i + 1}`} · {s.bars || '?'} b{s.bpm ? ` · ${s.bpm}` : ''}
                  {s.timeSig ? ` · ${s.timeSig}` : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="d-col">
        <div className="panel-head">
          <Icon name="layers" size={13} /> Sequenza · {stems.length} tracce
        </div>
        <div className="d-body">
          {stems.length === 0 && !video && (
            <p className="small muted">
              Nessuna traccia. Caricale dalla pagina <b>Scaletta</b> (scheda <b>Sequenze, Video &amp; PDF</b>) o dall’app web.
              {item.bpm ? ' Puoi comunque suonarlo con il click.' : ''}
            </p>
          )}
          {groups.length > 0 && (
            <div className="rehearsal-bar" title="Rehearsal: togli dal mix uno strumento (vale per tutti i brani, fino alla chiusura dell’app)">
              <span className="small muted">Rehearsal</span>
              {groups.map((g) => (
                <button
                  key={g}
                  className={`toggle ${player.leftOut[g] ? 'is-out' : ''}`}
                  aria-pressed={!player.leftOut[g]}
                  onClick={() => player.toggleGroup(g)}
                  title={player.leftOut[g] ? 'Rimetti nel mix' : 'Togli dal mix'}
                >
                  {groupLabel(g)}
                </button>
              ))}
            </div>
          )}
          {stems.map((s) => (
            <div
              key={s.id}
              className={`d-media-row ${player.leftOut[rehearsalGroup(s)] ? 'is-out' : ''}`}
              style={{ '--lane-color': laneColor(lanes, s) }}
            >
              <span className="swatch" />
              <span className="ellipsis" title={s.file}>
                {s.name} <span className="small faint">· {STEM_ROLES[s.role || 'main']?.label}</span>
              </span>
              <span className="small faint mono">{formatBytes(s.size)}</span>
              <CacheState c={cache[s.path]} />
            </div>
          ))}
          {video && (
            <div className="d-media-row" style={{ '--lane-color': ROLE_COLORS.video }}>
              <span className="swatch" />
              <span className="ellipsis" title={video.file}>
                {video.name} <span className="small faint">· Video{video.offset ? ` · offset ${video.offset}s` : ''}</span>
              </span>
              <span className="small faint mono">{formatBytes(video.size)}</span>
              <CacheState c={cache[video.path]} />
            </div>
          )}
        </div>
      </div>

      <div className="d-col" style={{ borderRight: 'none' }}>
        <div className="panel-head">
          <Icon name="video" size={13} /> Video
          <span className="grow" />
          <button className="btn btn-ghost btn-sm" onClick={onVideoOutput} title="Apri l’uscita video su un secondo schermo">
            <Icon name="monitor" size={14} /> Uscita
          </button>
        </div>
        <div className="video-box">
          {loaded?.video ? (
            <SyncedVideo src={loaded.video.src} offset={loaded.video.offset || 0} />
          ) : (
            <span className="video-empty">{video ? 'Il video parte quando il brano è nel player.' : 'Nessun video per il brano nel player.'}</span>
          )}
        </div>
      </div>
    </section>
  );
}
