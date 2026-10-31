import { useRef, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { formatDuration, getRole, PLAYBACK_TYPES, ROLE_LABELS } from '../shared/setlists.js';
import { formatBytes, stemsOf, videoOf } from '../shared/media.js';
import {
  canEditSong,
  canManageSong,
  createSong,
  deleteSong,
  importFromSetlists,
  importSummary,
  itemFromSong,
  updateSong,
  useLibrary,
} from '../shared/songs.js';
import { useAccess } from '../lib/data';
import { db, storage } from '../lib/firebase';
import Icon from './Icon';
import { SongInspector } from './SetlistEditor';
import { ZoneResizer } from './Zones';

// "Brani" page: the song library shared with the web app. Songs are edited
// with the same inspector as the setlist page; their stems and video belong
// to the song, so every setlist using it plays the same files.

const FILTERS = [
  ['all', 'Tutti'],
  ['mine', 'I miei'],
  ['shared', 'Condivisi'],
];

const mediaBytes = (s) => stemsOf(s).reduce((a, x) => a + (x.size || 0), 0) + (videoOf(s)?.size || 0);

export default function SongsPage({ user, setlists, setlist, setlistItems, canEditSetlist, notify }) {
  const email = (user.email || '').toLowerCase();
  const { isAdmin, canCreate: creator } = useAccess(user);
  const library = useLibrary(user.uid, email);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [title, setTitle] = useState('');
  const [importing, setImporting] = useState(null); // { step, total, text }
  const deleting = useRef(new Set()); // no late save (inspector unmount) of a deleted song
  const titleRef = useRef(null);

  const list = library[filter];
  const q = search.trim().toLowerCase();
  const shown = (list || []).filter((s) => !q || `${s.title} ${s.artist || ''} ${s.key || ''} ${s.genre || ''}`.toLowerCase().includes(q));
  const selected = (library.all || []).find((s) => s.id === selectedId) || null;
  const inSetlist = new Set((setlistItems || []).map((it) => it.songId).filter(Boolean));
  const grid = { gridTemplateColumns: '28px minmax(180px, 1fr) 54px 64px 52px 110px 96px' };

  const fail = (e) => notify(`Libreria non aggiornata: ${e.message || e}`, true);

  const create = (e) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    const { id, done } = createSong(user, { title: t });
    done.catch(fail);
    setTitle('');
    setFilter('all');
    setSelectedId(id);
    notify(`Creato “${t}”: aggiungi dati, tracce e video a destra`);
  };

  const save = (song, data) =>
    !deleting.current.has(song.id) &&
    updateSong(song.id, data)
      .then(() => notify(`Salvato “${data.title || song.title}”`))
      .catch(fail);

  const remove = async (song) => {
    const media = stemsOf(song).length || videoOf(song);
    if (!confirm(`Eliminare definitivamente “${song.title}” dalla libreria?${media ? ' Tracce e video vengono cancellati dallo storage, anche nelle scalette che usano il brano.' : ''}`)) return;
    try {
      deleting.current.add(song.id);
      if (selectedId === song.id) setSelectedId(null);
      await deleteSong(storage, song);
      notify(`Eliminato “${song.title}” dalla libreria`);
    } catch (e) {
      fail(e);
    }
  };

  const addToSetlist = async (song) => {
    try {
      const order = (setlistItems || []).reduce((m, i) => Math.max(m, i.order ?? 0), -1) + 1;
      await addDoc(collection(db, 'setlists', setlist.id, 'items'), {
        ...itemFromSong(song),
        type: 'song',
        order,
        values: {},
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      updateDoc(doc(db, 'setlists', setlist.id), { updatedAt: serverTimestamp() }).catch(() => {});
      notify(`Aggiunto “${song.title}” a “${setlist.title}”`);
    } catch (e) {
      fail(e);
    }
  };

  const runImport = async () => {
    if (
      !confirm(
        'Importare nella libreria i brani delle scalette che puoi modificare? I brani con lo stesso titolo e artista diventano uno solo; tracce e video vengono copiati nel brano della libreria (i file originali vengono poi eliminati).',
      )
    )
      return;
    setImporting({ step: 0, total: 0, text: 'Lettura delle scalette…' });
    try {
      const r = await importFromSetlists({ user, setlists: setlists || [], library: library.all, isAdmin, storage, onProgress: setImporting });
      notify(importSummary(r), r.errors.length > 0);
      if (r.errors.length) console.warn('Importazione', r.errors);
    } catch (e) {
      fail(e);
    } finally {
      setImporting(null);
    }
  };

  return (
    <div className="setlist-editor">
      <div className="arr-toolbar">
        <Icon name="music" size={15} />
        <strong>Brani</strong>
        <span className="small muted">
          {library.all ? `${library.all.length} in libreria` : 'Caricamento…'}
          {importing && ` · importazione ${importing.total ? `${importing.step}/${importing.total} · ` : ''}${importing.text}`}
        </span>
        <span className="grow" />
        <span className="se-tabs songs-filter" role="tablist">
          {FILTERS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? 'is-on' : ''} onClick={() => setFilter(k)}>
              {label}
              {library[k]?.length > 0 && <span className="se-count">{library[k].length}</span>}
            </button>
          ))}
        </span>
        <span className="songs-search">
          <Icon name="search" size={13} />
          <input className="input" placeholder="Filtra…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </span>
        {creator && (
          <button className="btn btn-sm btn-primary" onClick={() => titleRef.current?.focus()} title="Scrivi il titolo in fondo all’elenco e premi Invio">
            <Icon name="plus" size={13} /> Nuovo brano
          </button>
        )}
        {creator && (
          <button className="btn btn-sm" onClick={runImport} disabled={!!importing || !setlists} title="Porta nella libreria i brani delle tue scalette">
            <Icon name="download" size={13} /> {importing ? 'Importazione…' : 'Importa dalle scalette'}
          </button>
        )}
      </div>

      <div className="se-main">
        <div className="se-list-wrap">
          <div className="se-list">
            <div className="se-row se-head" style={grid}>
              <span />
              <span>Titolo & artista</span>
              <span>Tonalità</span>
              <span>BPM</span>
              <span>Durata</span>
              <span>Media</span>
              <span />
            </div>
            {shown.map((s) => {
              const role = getRole(s, user.uid, email, isAdmin);
              const stems = stemsOf(s).length;
              return (
                <div key={s.id} className={`se-row ${s.id === selectedId ? 'is-selected' : ''}`} style={grid} onClick={() => setSelectedId(s.id)}>
                  <span className="se-num">
                    <Icon name="music" size={13} />
                  </span>
                  <span className="se-title-cell">
                    <span className="ellipsis se-song-title">{s.title}</span>
                    <span className="se-sub">
                      {s.playback && <span className={`tag tag-play-${s.playback}`}>{PLAYBACK_TYPES[s.playback]?.label}</span>}
                      {s.artist && <span className="ellipsis">{s.artist}</span>}
                      {role !== 'owner' && <span className="tag">{ROLE_LABELS[role] || '—'}</span>}
                      {inSetlist.has(s.id) && <span className="tag">In scaletta</span>}
                    </span>
                  </span>
                  <span className="se-key">{s.key || ''}</span>
                  <span className="small">
                    {s.bpm && <b className="mono">{s.bpm}</b>} <span className="faint">{s.timeSig || ''}</span>
                  </span>
                  <span className="mono small">{formatDuration(s.duration)}</span>
                  <span className="small faint" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    {stems > 0 && (
                      <>
                        <Icon name="layers" size={12} /> {stems}
                      </>
                    )}
                    {videoOf(s) && <Icon name="video" size={12} />}
                    {(stems > 0 || videoOf(s)) && <span className="mono">{formatBytes(mediaBytes(s))}</span>}
                  </span>
                  <span className="se-actions">
                    {canEditSetlist && setlist && (
                      <button className="toggle" onClick={(e) => (e.stopPropagation(), addToSetlist(s))} title={`Aggiungi a “${setlist.title}”`}>
                        <Icon name="plus" size={11} />
                      </button>
                    )}
                    {canManageSong(s, user.uid, isAdmin) && (
                      <button className="toggle" onClick={(e) => (e.stopPropagation(), remove(s))} title="Elimina dalla libreria (con tracce e video)">
                        <Icon name="trash" size={11} />
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
            {list && !shown.length && (
              <p className="pr-note">
                {q
                  ? 'Nessun brano corrisponde al filtro.'
                  : filter === 'shared'
                    ? 'Nessun brano condiviso con te.'
                    : 'La libreria è vuota: i brani che aggiungi alle scalette compaiono qui. Puoi anche importare quelli che hai già o crearne uno qui sotto.'}
              </p>
            )}
          </div>
          {creator && (
            <form className="se-quick" onSubmit={create}>
              <Icon name="music" size={13} />
              <input
                ref={titleRef}
                className="input grow"
                placeholder="Nuovo brano in libreria: titolo e Invio…"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <button className="btn btn-sm btn-primary" disabled={!title.trim()}>
                <Icon name="plus" size={13} /> Brano
              </button>
              <span className="small faint">La condivisione dei brani si gestisce dall’app web.</span>
            </form>
          )}
        </div>

        {!selected ? (
          <aside className="se-inspector">
            <div className="empty">Seleziona un brano della libreria.</div>
          </aside>
        ) : (
          <SongInspector
            key={selected.id}
            library
            setlistId={null}
            item={selected}
            columns={[]}
            canEdit={canEditSong(selected, user.uid, email, isAdmin)}
            canDelete={canManageSong(selected, user.uid, isAdmin)}
            onSave={save}
            onDelete={remove}
            onTrack={notify}
            notify={notify}
          />
        )}
        <ZoneResizer zone="right" />
      </div>
    </div>
  );
}
