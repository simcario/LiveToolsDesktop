import { formatDuration, PLAYBACK_TYPES } from '../shared/setlists.js';
import { compareGroups, formatBytes, groupLabel, rehearsalGroup, STEM_ROLES, stemsOf, videoOf } from '../shared/media.js';
import { keyLabel } from '../shared/music.js';
import { ensureItems, useMediaCache } from '../lib/mediaCache';
import { useMix, useSettings } from '../lib/settings';
import { trackMuted } from '../lib/songMix';
import { laneColor, ROLE_COLORS } from '../lib/lanes';
import Icon from './Icon';
import SyncControl from './SyncControl';
import SyncedVideo from './SyncedVideo';
import { useOutputOpen } from '../lib/outputs';
import { ZoneLayoutToggle, ZoneTabs } from './Zones';
import MixerPanel from './MixerPanel';

const TABS = [
  ['song', 'Brano', 'music'],
  ['tracks', 'Tracce', 'layers'],
  ['video', 'Video', 'video'],
  ['mixer', 'Mixer', 'sliders'],
];

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

export default function DetailView({ item, number, lanes, player, mixer, onVideoOutput }) {
  const videoOpen = useOutputOpen('video');
  const cache = useMediaCache();
  const loaded = player.loaded;
  const [settings, update] = useSettings();
  useMix(); // the track mutes of this computer
  const tab = TABS.some(([k]) => k === settings.detailTab) ? settings.detailTab : 'song';
  // The mixer takes the whole zone: shown as a tab even with the panels side by side.
  const tabbed = settings.sideTabs || tab === 'mixer';
  const col = (k) => `d-col ${tabbed && tab !== k ? 'is-off' : ''}`;

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
  const sections = (item.sections || []).filter((s) => !s.gap && (s.label || s.bars));
  // Rehearsal: the groups of the loaded song; a touch mutes all their tracks (the same mute as the Arrangement and the Palco).
  const groups = isLoaded ? [...new Set(stems.map(rehearsalGroup))].filter(Boolean).sort(compareGroups) : [];
  const stemMuted = (s) => (isLoaded ? trackMuted(s, !player.mixSaved) : !!s.muted);
  const missing = [...stems, ...(video ? [video] : [])].some((m) => !cache[m.path]?.ready);

  return (
    <section className={`detail ${tabbed ? 'is-tabbed' : ''}`}>
      {tabbed && <ZoneTabs label="Pannelli del Dettaglio" tabs={TABS} active={tab} onChange={(detailTab) => update({ detailTab })} />}
      <div className={col('song')}>
        <div className="panel-head">
          Brano {number ? `#${String(number).padStart(2, '0')}` : ''}
          {isLoaded && <span className="tag tag-play-backing">Nel player</span>}
          {!tabbed && <ZoneLayoutToggle />}
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

      <div className={col('tracks')}>
        <div className="panel-head">
          <Icon name="layers" size={13} /> Sequenza · {stems.length} tracce
          <span className="grow" />
          {!tabbed && (
            <button className="btn btn-ghost btn-sm" onClick={() => update({ detailTab: 'mixer' })} title="Volumi, pan e gruppi delle tracce (F3: in una finestra)">
              <Icon name="sliders" size={13} /> Mixer
            </button>
          )}
        </div>
        <div className="d-body">
          {stems.length === 0 && !video && (
            <p className="small muted">
              Nessuna traccia. Caricale dalla pagina <b>Scaletta</b> (scheda <b>Sequenze, Video &amp; PDF</b>) o dall’app web.
              {item.bpm ? ' Puoi comunque suonarlo con il click.' : ''}
            </p>
          )}
          {groups.length > 0 && (
            <div className="rehearsal-bar" title="Rehearsal: muta o riattiva tutte le tracce di uno strumento (come nell’Arrangement e nel Palco)">
              <span className="small muted">Rehearsal</span>
              {groups.map((g) => {
                const m = player.groupMute(g);
                const out = m.total > 0 && m.muted === m.total;
                return (
                  <button
                    key={g}
                    className={`toggle ${out ? 'is-out' : ''} ${m.muted && !out ? 'is-partial' : ''}`}
                    aria-pressed={out ? false : m.muted ? 'mixed' : true}
                    onClick={() => player.toggleGroup(g)}
                    title={out ? 'Riattiva tutte le tracce' : m.muted ? `Mutate ${m.muted} di ${m.total}: ${m.names.join(', ')} · tocca per mutarle tutte` : 'Muta tutte le tracce'}
                  >
                    {groupLabel(g)}
                    {m.muted > 0 && !out ? ` ${m.muted}/${m.total}` : ''}
                  </button>
                );
              })}
            </div>
          )}
          {stems.map((s) => (
            <div
              key={s.id}
              className={`d-media-row ${stemMuted(s) ? 'is-out' : ''}`}
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

      <div className={col('video')} style={{ borderRight: 'none' }}>
        <div className="panel-head">
          <Icon name="video" size={13} /> Video
          <span className="grow" />
          <button className={`btn btn-ghost btn-sm ${videoOpen ? 'is-on' : ''}`} onClick={onVideoOutput} aria-pressed={videoOpen} title={videoOpen ? 'Chiudi l’uscita video (F4)' : 'Apri l’uscita video (F4)'}>
            <Icon name="monitor" size={14} /> Uscita
          </button>
        </div>
        <div className="video-box">
          {loaded?.video ? (
            <SyncedVideo src={loaded.video.src} offset={loaded.video.offset || 0} fades={loaded.video.fades} />
          ) : (
            <span className="video-empty">{video ? 'Il video parte quando il brano è nel player.' : 'Nessun video per il brano nel player.'}</span>
          )}
        </div>
      </div>
      {tab === 'mixer' && mixer && <MixerPanel state={mixer.state} dispatch={mixer.dispatch} />}
    </section>
  );
}
