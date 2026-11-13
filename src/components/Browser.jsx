import { useMemo, useState } from 'react';
import { formatEventDate, formatLong, isSeparator } from '../shared/setlists.js';
import { stemsOf, videoOf } from '../shared/media.js';
import { scoreForms } from '../shared/score.js';
import { useDrafts } from '../lib/drafts';
import { ensureItems, itemCacheState, mediaOf, useMediaCache } from '../lib/mediaCache';
import { useSettings } from '../lib/settings';
import Icon from './Icon';
import { openContextMenu } from './ContextMenu';
import SectionsPanel from './SectionsPanel';
import { ZoneLayoutToggle, ZoneTabs } from './Zones';

const TABS = [
  ['songs', 'Brani', 'layers'],
  ['setlists', 'Scalette', 'list-music'],
  ['sections', 'Sezioni', 'timeline'],
];

const CACHE_HINT = {
  ready: ['ok', 'Media scaricati'],
  partial: ['warn', 'Media da scaricare'],
  downloading: ['warn', 'Download in corso'],
  error: ['err', 'Download non riuscito'],
};

export default function Browser({ setlists, setlistId, onSetlist, items, numbers, selectedId, loadedId, liveItemId, onSelect, onLoad, player, canEdit, notify, showSections }) {
  const [settings, update] = useSettings();
  const tabbed = settings.sideTabs;
  // The saved tab stays: back in the Arrangement, the sections are there again.
  const tabs = showSections ? TABS : TABS.filter(([k]) => k !== 'sections');
  const tab = tabs.some(([k]) => k === settings.browserTab) ? settings.browserTab : 'songs';
  const shows = (k) => !tabbed || tab === k;
  const drafts = useDrafts();
  const cache = useMediaCache();
  const [syncing, setSyncing] = useState(false);

  const files = useMemo(() => items.flatMap(mediaOf), [items]);
  const ready = files.filter((f) => cache[f.path]?.ready).length;
  const bytes = files.reduce((a, f) => a + (f.size || 0), 0);
  const done = files.reduce((a, f) => {
    const c = cache[f.path] || {};
    return a + (c.ready ? f.size || 0 : c.received || 0);
  }, 0);

  // Right click on a song: load, play, open it in the other pages, download.
  const songMenu = (e, it, st) => {
    const isLoaded = it.id === loadedId;
    const go = (patch) => {
      onSelect(it.id);
      update(patch);
    };
    openContextMenu(
      e,
      [
        !isLoaded && { label: 'Carica nel player', icon: 'download', onSelect: () => onLoad(it) },
        { label: isLoaded ? 'Play / Stop' : 'Carica e suona', icon: 'play', onSelect: () => player.launch(it) },
        '-',
        { label: 'Palco', icon: 'radio', onSelect: () => go({ page: 'live', view: 'stage' }) },
        { label: 'Arrangement', icon: 'timeline', onSelect: () => go({ page: 'live', view: 'arrangement' }) },
        { label: 'Gobbo', icon: 'lyrics', onSelect: () => go({ page: 'live', view: 'prompter' }) },
        scoreForms(it).length > 0 && { label: 'Spartito', icon: 'file-text', onSelect: () => go({ page: 'live', view: 'score' }) },
        { label: 'Modifica nella Scaletta', icon: 'edit', onSelect: () => go({ page: 'setlist' }) },
        '-',
        (st === 'partial' || st === 'error') && {
          label: st === 'error' ? 'Riprova a scaricare i file' : 'Scarica i file su questo computer',
          icon: 'download',
          onSelect: () => ensureItems([it]).catch((err) => notify(`Download non riuscito: ${err?.message || err}`, true)),
        },
      ],
      { title: `${numbers[it.id]} · ${it.title}` },
    );
  };
  const setlistMenu = (e, s) =>
    openContextMenu(
      e,
      [
        { label: 'Apri', icon: 'list-music', disabled: s.id === setlistId, onSelect: () => onSetlist(s.id) },
        { label: 'Apri nel Palco', icon: 'radio', onSelect: () => (onSetlist(s.id), update({ page: 'live', view: 'stage' })) },
        { label: 'Modifica la scaletta', icon: 'edit', onSelect: () => (onSetlist(s.id), update({ page: 'setlist' })) },
        s.id === setlistId && files.length > ready && { label: 'Scarica tutta la scaletta', icon: 'download', disabled: syncing, onSelect: syncAll },
      ],
      { title: s.title || 'Senza titolo' },
    );

  const syncAll = async () => {
    setSyncing(true);
    await ensureItems(items);
    setSyncing(false);
  };

  return (
    <aside className={`browser ${tabbed ? 'is-tabbed' : ''}`}>
      {tabbed && <ZoneTabs label="Pannelli del Browser" tabs={tabs} active={tab} onChange={(browserTab) => update({ browserTab })} />}
      {!tabbed && (
        <div className="panel-head">
          <Icon name="list-music" size={13} /> Scalette
          <ZoneLayoutToggle />
        </div>
      )}
      <div className="browser-setlists" hidden={!shows('setlists')}>
        {setlists === null && <p className="small muted" style={{ padding: 10 }}>Caricamento…</p>}
        {setlists?.length === 0 && (
          <p className="small muted" style={{ padding: 10 }}>
            Nessuna scaletta. Creale o fattele condividere dall’app web LiveTools.
          </p>
        )}
        {setlists?.map((s) => (
          <button key={s.id} className={`b-row ${s.id === setlistId ? 'is-on' : ''}`} onClick={() => onSetlist(s.id)} onContextMenu={(e) => setlistMenu(e, s)}>
            <span className="grow">
              <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>
                {s.title || 'Senza titolo'}
              </span>
              <span className="b-sub">
                {[s.event?.date && formatEventDate(s.event), s.stats?.songs && `${s.stats.songs} brani`, s.stats?.duration && formatLong(s.stats.duration)]
                  .filter(Boolean)
                  .join(' · ') || ' '}
              </span>
            </span>
            {s.live?.startedAt && <span className="dot live" title="Live" />}
          </button>
        ))}
      </div>

      {!tabbed && (
        <div className="panel-head">
          <Icon name="layers" size={13} /> Brani
        </div>
      )}
      <div className="browser-songs" hidden={!shows('songs')}>
        {items.map((it) => {
          if (isSeparator(it)) {
            return (
              <div key={it.id} className="b-sep">
                {it.title}
              </div>
            );
          }
          const st = itemCacheState(it, cache);
          const n = stemsOf(it).length;
          return (
            <button
              key={it.id}
              className={`b-song ${it.id === selectedId ? 'is-selected' : ''} ${it.id === loadedId ? 'is-loaded' : ''} ${it.id === liveItemId ? 'is-live' : ''}`}
              onClick={() => onSelect(it.id)}
              onDoubleClick={() => onLoad(it)}
              onContextMenu={(e) => songMenu(e, it, st)}
              title="Doppio clic: carica nel player · clic destro: altre azioni"
            >
              <span className="b-num">{String(numbers[it.id]).padStart(2, '0')}</span>
              <span className="ellipsis">{it.title}</span>
              {drafts[it.id] && (
                <span className="b-unsaved" title="Modifiche dell’Arrangement non salvate">
                  ●
                </span>
              )}
              <span className="small faint" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                {n > 0 && `${n}`}
                {videoOf(it) && <Icon name="video" size={12} />}
                {scoreForms(it).length > 0 && (
                  <span title={`Spartito: ${scoreForms(it).join(', ')}`} style={{ display: 'inline-flex' }}>
                    <Icon name="file-text" size={12} />
                  </span>
                )}
                {st !== 'none' && <span className={`dot ${CACHE_HINT[st][0]}`} title={CACHE_HINT[st][1]} />}
              </span>
            </button>
          );
        })}
      </div>

      {showSections && !tabbed && (
        <div className="panel-head">
          <Icon name="timeline" size={13} /> Sezioni
        </div>
      )}
      {showSections && shows('sections') && (
        <div className="browser-sections">
          <SectionsPanel player={player} setlistId={setlistId} canEdit={canEdit} notify={notify} />
        </div>
      )}

      {files.length > 0 && (
        <div className="browser-foot">
          <div className="small muted" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>
              Media offline {ready}/{files.length}
            </span>
            <span className="mono">{(bytes / 1024 ** 3).toFixed(2)} GB</span>
          </div>
          <div className="bar-progress">
            <span style={{ width: `${bytes ? (done / bytes) * 100 : 0}%` }} />
          </div>
          {ready < files.length && (
            <button className="btn btn-sm" onClick={syncAll} disabled={syncing}>
              <Icon name="download" size={14} /> {syncing ? 'Download in corso…' : 'Scarica tutta la scaletta'}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
