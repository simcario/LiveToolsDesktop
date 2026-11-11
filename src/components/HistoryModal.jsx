import { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { restoreVersion, saveVersion } from '../shared/history.js';
import { formatLong, genreBreakdown, isSeparator, totalDuration } from '../shared/setlists.js';
import Icon from './Icon';

// Storico e analisi of the setlist, as the web app's HistoryModal: the changes made
// (setlists/{id}/history), the versions to go back to (setlists/{id}/versions, one saved
// by itself before the edits at most every 30 minutes) and the genres and duration of the set.
// Shared by the desktop (Scaletta page) and the tablet (menu ⋯, `sheet`).

const GENRE_COLORS = ['var(--accent)', 'var(--cyan)', 'var(--violet)', '#22c55e', '#f472b6', '#94a3b8'];

export function when(ts) {
  const d = ts?.toDate?.();
  if (!d) return 'adesso';
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Oggi alle ${time}`;
  if (yesterday) return `Ieri alle ${time}`;
  return d.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
}

function useCollection(setlistId, name, max) {
  const [docs, setDocs] = useState(null);
  useEffect(
    () =>
      onSnapshot(
        query(collection(db, 'setlists', setlistId, name), orderBy('at', 'desc'), limit(max)),
        (s) => setDocs(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
        () => setDocs([]),
      ),
    [setlistId, name, max],
  );
  return docs;
}

function Analytics({ setlist, items }) {
  const genres = genreBreakdown(items);
  const songs = items.filter((it) => !isSeparator(it));
  const done = items.filter((it) => it.completed);
  const startedAt = setlist.live?.startedAt?.toMillis?.();
  const lastDone = Math.max(0, ...done.map((it) => it.completedAt?.toMillis?.() ?? 0));
  const actual = startedAt ? ((lastDone || Date.now()) - startedAt) / 1000 : null;
  const planned = totalDuration(done);
  const delta = actual !== null && planned ? actual - planned : null;
  return (
    <div className="hist-stats">
      <section>
        <h3>Ripartizione generi</h3>
        {genres.length === 0 ? (
          <p className="small muted">Indica il genere nei brani (scheda Brano) per vedere la ripartizione.</p>
        ) : (
          <>
            <div className="hist-genre-bar" role="img" aria-label={genres.map((g) => `${g.genre} ${g.pct}%`).join(', ')}>
              {genres.map((g, i) => (
                <span key={g.genre} style={{ width: `${g.pct}%`, background: GENRE_COLORS[i % GENRE_COLORS.length] }} />
              ))}
            </div>
            <ul className="hist-legend">
              {genres.map((g, i) => (
                <li key={g.genre}>
                  <span className="hist-swatch" style={{ background: GENRE_COLORS[i % GENRE_COLORS.length] }} />
                  {g.genre} {g.pct}%
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section>
        <h3>Durata</h3>
        <div className="hist-tiles">
          <div>
            <span>Stimata set</span>
            <strong>{formatLong(totalDuration(items))}</strong>
          </div>
          <div>
            <span>Brani suonati</span>
            <strong>
              {done.length}/{songs.length}
            </strong>
          </div>
          <div>
            <span>Effettiva</span>
            <strong className={delta > 60 ? 'is-warn' : 'is-cyan'}>{actual !== null ? formatLong(actual) : '—'}</strong>
          </div>
        </div>
        <p className="small muted">
          {actual === null
            ? 'La durata effettiva si misura da quando chi guida avvia il live.'
            : delta !== null
              ? `Rispetto alla durata stimata dei brani completati (${formatLong(planned)}): ${delta >= 0 ? '+' : '−'}${formatLong(Math.abs(delta))}.`
              : 'Segna i brani come completati per confrontare con la durata stimata.'}
        </p>
      </section>
    </div>
  );
}

/**
 * items: the setlist as shown (genres, durations); itemDocs: the items as stored, what a
 * version saves and a restore replaces.
 */
export default function HistoryModal({ user, setlist, items, itemDocs, canEdit, notify, onClose, sheet = false }) {
  const [tab, setTab] = useState('log');
  const log = useCollection(setlist.id, 'history', 60);
  const versions = useCollection(setlist.id, 'versions', 30);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (fn, done) => {
    setBusy(true);
    try {
      await fn();
      if (done) notify?.(done);
    } catch (e) {
      notify?.(e?.message || String(e), true);
    } finally {
      setBusy(false);
    }
  };
  const restore = (v) => {
    if (!confirm(`Ripristinare la scaletta com’era (${when(v.at)})? Lo stato attuale viene salvato come versione.`)) return;
    run(async () => {
      await restoreVersion(setlist, itemDocs, v, user);
      onClose();
    }, `Scaletta ripristinata com’era ${when(v.at).toLowerCase()}`);
  };
  const previous = versions?.find((v) => v.label !== 'Prima del ripristino') ?? versions?.[0];

  const body = (
    <>
      <div className="hist-tabs" role="tablist">
        {[
          ['log', 'Modifiche'],
          ['versions', 'Versioni'],
          ['stats', 'Analisi'],
        ].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'log' && (
        <>
          {canEdit && previous && (
            <button className="btn btn-sm hist-start" onClick={() => restore(previous)} disabled={busy}>
              <Icon name="undo" size={14} /> Ripristina la versione precedente ({when(previous.at)})
            </button>
          )}
          {log === null ? (
            <p className="small muted">Caricamento…</p>
          ) : log.length === 0 ? (
            <p className="small muted">Nessuna modifica registrata.</p>
          ) : (
            <ul className="hist-timeline">
              {log.map((e) => (
                <li key={e.id}>
                  <span className="hist-dot" />
                  <div>
                    <strong>{e.text}</strong>
                    <span className="small muted">
                      {when(e.at)} · {e.byName || e.by}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {tab === 'versions' && (
        <>
          {canEdit && (
            <button className="btn btn-sm hist-start" onClick={() => run(() => saveVersion(setlist, itemDocs, user, 'Versione salvata a mano'), 'Versione salvata')} disabled={busy}>
              <Icon name="plus" size={14} /> Salva versione ora
            </button>
          )}
          <p className="small muted">Prima delle modifiche viene salvata da sola una copia della scaletta (al massimo ogni 30 minuti).</p>
          {versions?.length === 0 && <p className="small muted">Nessuna versione salvata.</p>}
          <ul className="hist-versions">
            {(versions || []).map((v) => (
              <li key={v.id}>
                <span>
                  <strong>{v.label}</strong>
                  <span className="small muted">
                    {' '}
                    · {when(v.at)} · {v.byName || v.by} · {v.songCount ?? v.items?.length} brani
                  </span>
                </span>
                {canEdit && (
                  <button className="btn btn-sm" onClick={() => restore(v)} disabled={busy}>
                    <Icon name="undo" size={13} /> Ripristina
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {tab === 'stats' && <Analytics setlist={setlist} items={items} />}
    </>
  );

  if (sheet)
    return (
      <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="sheet hist" role="dialog" aria-modal="true" aria-label="Storico e analisi">
          <div className="sheet-head">
            <h2>Storico e analisi</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Chiudi">
              <Icon name="x" size={20} />
            </button>
          </div>
          <div className="sheet-body">{body}</div>
        </div>
      </div>
    );
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal hist" role="dialog" aria-modal="true" aria-label="Storico e analisi">
        <div className="modal-head">
          <h2>Storico e analisi · {setlist.title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Chiudi">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal-body">{body}</div>
      </div>
    </div>
  );
}
