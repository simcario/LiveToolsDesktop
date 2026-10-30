import { useMemo, useState } from 'react';
import { formatEventDate, formatLong, isSeparator } from '../shared/setlists.js';
import { stemsOf, videoOf } from '../shared/media.js';
import { useDrafts } from '../lib/drafts';
import { ensureItems, itemCacheState, mediaOf, useMediaCache } from '../lib/mediaCache';
import Icon from './Icon';

const CACHE_HINT = {
  ready: ['ok', 'Media scaricati'],
  partial: ['warn', 'Media da scaricare'],
  downloading: ['warn', 'Download in corso'],
  error: ['err', 'Download non riuscito'],
};

export default function Browser({ setlists, setlistId, onSetlist, items, numbers, selectedId, loadedId, liveItemId, onSelect, onLoad }) {
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

  const syncAll = async () => {
    setSyncing(true);
    await ensureItems(items);
    setSyncing(false);
  };

  return (
    <aside className="browser">
      <div className="panel-head">
        <Icon name="list-music" size={13} /> Scalette
      </div>
      <div className="browser-setlists">
        {setlists === null && <p className="small muted" style={{ padding: 10 }}>Caricamento…</p>}
        {setlists?.length === 0 && (
          <p className="small muted" style={{ padding: 10 }}>
            Nessuna scaletta. Creale o fattele condividere dall’app web LiveTools.
          </p>
        )}
        {setlists?.map((s) => (
          <button key={s.id} className={`b-row ${s.id === setlistId ? 'is-on' : ''}`} onClick={() => onSetlist(s.id)}>
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

      <div className="panel-head">
        <Icon name="layers" size={13} /> Brani
      </div>
      <div className="browser-songs">
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
              title="Doppio clic: carica nel player"
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
                {st !== 'none' && <span className={`dot ${CACHE_HINT[st][0]}`} title={CACHE_HINT[st][1]} />}
              </span>
            </button>
          );
        })}
      </div>

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
