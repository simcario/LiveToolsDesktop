import { useRef, useState } from 'react';
import {
  AUDIO_EXTENSIONS,
  deleteAllStems,
  deleteMediaFile,
  formatBytes,
  instrumentOf,
  INSTRUMENTS,
  isAudioFile,
  isVideoFile,
  mediaTarget,
  saveScore,
  saveStems,
  saveVideo,
  STEM_ROLES,
  stemsOf,
  VIDEO_EXTENSIONS,
  videoOf,
} from '../shared/media.js';
import { isPdfFile, scoreOf } from '../shared/score.js';
import { db, storage } from '../lib/firebase';
import { useMediaCache } from '../lib/mediaCache';
import { startUploads, useUploads } from '../lib/uploads';
import { CacheState } from './DetailView';
import Icon from './Icon';

// "Sequenze, Video & PDF" of a song in the setlist page: same data as the web app,
// saved as soon as it changes (uploads and deletions cannot wait for “Salva”).

function StemRow({ stem, index, count, canEdit, cache, onPatch, onMove, onRemove }) {
  const [name, setName] = useState(stem.name);
  const instrument = instrumentOf(stem);
  const commit = () => {
    const n = name.trim();
    if (n && n !== stem.name) onPatch({ name: n });
    else setName(stem.name);
  };
  return (
    <div className={`md-row role-${stem.role || 'main'}`}>
      <span className="swatch" />
      <span className="md-main">
        <input
          className="pr-label"
          value={name}
          disabled={!canEdit}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          aria-label="Nome traccia"
        />
        <span className="small faint ellipsis" title={stem.file}>
          {stem.file} · {formatBytes(stem.size)}
        </span>
      </span>
      <select
        className="select-xs md-role"
        value={stem.role || 'main'}
        disabled={!canEdit}
        onChange={(e) => onPatch({ role: e.target.value })}
        title={STEM_ROLES[stem.role || 'main']?.hint}
      >
        {Object.entries(STEM_ROLES).map(([k, r]) => (
          <option key={k} value={k}>
            {r.label}
          </option>
        ))}
      </select>
      {instrument && (
        <select
          className="select-xs md-role"
          value={instrument}
          disabled={!canEdit}
          onChange={(e) => onPatch({ instrument: e.target.value })}
          title="Strumento: il Rehearsal di chi lo suona lo toglie dal mix"
        >
          {Object.entries(INSTRUMENTS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      )}
      <CacheState c={cache} />
      {canEdit && (
        <span className="md-tools">
          <button
            className={`toggle mute ${stem.muted ? 'is-on' : ''}`}
            onClick={() => onPatch({ muted: !stem.muted })}
            title={stem.muted ? 'Disattivata di default' : 'Disattiva di default'}
          >
            M
          </button>
          <button className="toggle" disabled={index === 0} onClick={() => onMove(-1)} title="Sposta su">
            <Icon name="chevron-up" size={11} />
          </button>
          <button className="toggle" disabled={index === count - 1} onClick={() => onMove(1)} title="Sposta giù">
            <Icon name="chevron-down" size={11} />
          </button>
          <button className="toggle" onClick={onRemove} title="Elimina la traccia">
            <Icon name="trash" size={11} />
          </button>
        </span>
      )}
    </div>
  );
}

function UploadRow({ upload }) {
  return (
    <div className="md-row md-upload">
      <Icon name="cloud" size={13} />
      <span className="md-main">
        <span className="small ellipsis">{upload.name}</span>
        <span className="bar-progress">
          <span style={{ width: `${Math.round(upload.progress * 100)}%` }} />
        </span>
      </span>
      <span className="small mono">{Math.round(upload.progress * 100)}%</span>
      <button className="toggle" onClick={upload.cancel} title="Annulla il caricamento">
        <Icon name="x" size={11} />
      </button>
    </div>
  );
}

function Section({ title, icon, count, canEdit, multiple, accept, onFiles, button, tools, empty, children }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  const drop = canEdit
    ? {
        onDragOver: (e) => {
          e.preventDefault();
          setOver(true);
        },
        onDragLeave: (e) => !e.currentTarget.contains(e.relatedTarget) && setOver(false),
        onDrop: (e) => {
          e.preventDefault();
          setOver(false);
          onFiles([...e.dataTransfer.files]);
        },
      }
    : {};
  return (
    <div className={`md-section ${over ? 'is-over' : ''}`} {...drop}>
      <div className="md-head">
        <Icon name={icon} size={13} /> {title}
        {count > 0 && <span className="se-count">{count}</span>}
        <span className="grow" />
        {canEdit && tools}
        {canEdit && (
          <>
            <button type="button" className="btn btn-sm" onClick={() => input.current?.click()}>
              <Icon name="plus" size={13} /> {button}
            </button>
            <input
              ref={input}
              type="file"
              hidden
              multiple={multiple}
              accept={accept}
              onChange={(e) => {
                onFiles([...e.target.files]);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>
      {children}
      {empty && <p className="md-hint">{empty}</p>}
    </div>
  );
}

export default function MediaFields({ setlistId, item, canEdit: canEditSetlist, onTrack, notify }) {
  const cache = useMediaCache();
  const uploads = useUploads().filter((u) => u.itemId === item.id);
  const stems = stemsOf(item);
  const video = videoOf(item);
  // Library media are changed by who can edit the song, not the setlist.
  const canEdit = canEditSetlist && item.songEditable !== false;
  const target = mediaTarget(setlistId, item);
  const everywhere = item.songId ? 'dalla libreria e da tutte le scalette che usano il brano' : 'per tutti';
  const fail = (e) => notify(`Media non aggiornati: ${e.message || e}`, true);

  const score = scoreOf(item);
  const upload = (kind, files) => {
    const ok = files.filter(kind === 'stems' ? isAudioFile : kind === 'score' ? isPdfFile : isVideoFile);
    if (ok.length < files.length) {
      notify(kind === 'stems' ? 'Solo file audio (wav, aiff, flac, mp3…)' : kind === 'score' ? 'Solo file PDF' : 'Solo file video (mp4, mov, webm)', true);
    }
    if (!ok.length) return;
    startUploads({ setlistId, item, kind, files: kind === 'stems' ? ok : [ok[0]], onDone: onTrack, onError: (t) => notify(t, true) });
  };

  const patchStem = (id, p) => saveStems(db, target, stems.map((s) => (s.id === id ? { ...s, ...p } : s))).catch(fail);
  const moveStem = (i, d) => {
    const next = [...stems];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    saveStems(db, target, next).catch(fail);
  };
  const removeStem = async (stem) => {
    if (!confirm(`Eliminare la traccia “${stem.name}” di “${item.title}”? Il file viene eliminato ${everywhere}.`)) return;
    try {
      await saveStems(db, target, stems.filter((s) => s.id !== stem.id));
      await deleteMediaFile(storage, stem.path, target);
      onTrack(`Eliminata la traccia “${stem.name}” di “${item.title}”`);
    } catch (e) {
      fail(e);
    }
  };
  const removeSequence = async () => {
    if (!confirm(`Eliminare l’intera sequenza di “${item.title}” (${stems.length} tracce)? I file vengono cancellati dallo storage ${everywhere}.`)) return;
    try {
      await deleteAllStems(db, storage, target, stems);
      onTrack(`Eliminata la sequenza di “${item.title}” (${stems.length} tracce)`);
    } catch (e) {
      fail(e);
    }
  };
  const removeVideo = async () => {
    if (!confirm(`Eliminare il video di “${item.title}”? Il file viene eliminato ${everywhere}.`)) return;
    try {
      await saveVideo(db, target, null);
      await deleteMediaFile(storage, video.path, target);
      onTrack(`Eliminato il video di “${item.title}”`);
    } catch (e) {
      fail(e);
    }
  };

  const removeScore = async () => {
    if (!confirm(`Eliminare lo spartito PDF di “${item.title}”? Il file viene eliminato ${everywhere}.`)) return;
    try {
      await saveScore(db, target, null);
      await deleteMediaFile(storage, score.path, target);
      onTrack(`Eliminato lo spartito di “${item.title}”`);
    } catch (e) {
      fail(e);
    }
  };

  const stemUploads = uploads.filter((u) => u.kind === 'stems');
  const videoUploads = uploads.filter((u) => u.kind === 'video');
  const scoreUploads = uploads.filter((u) => u.kind === 'score');

  return (
    <div className="se-form">
      <p className="small muted" style={{ margin: 0 }}>
        Le modifiche di questa scheda vengono salvate subito, per tutta la band. I file caricati da qui restano anche su
        questo computer, pronti da suonare. Il ruolo decide l’uscita (impianto o cuffie, vedi matrice uscite).
        {item.songId && ' Tracce e video sono quelli del brano in libreria: valgono per tutte le scalette che lo usano.'}
        {canEditSetlist && !canEdit && ' Li modifica solo chi può modificare il brano in libreria.'}
      </p>
      <Section
        title="Sequenza / Multitraccia"
        icon="layers"
        count={stems.length}
        canEdit={canEdit}
        multiple
        accept={['audio/*', ...AUDIO_EXTENSIONS.map((x) => `.${x}`)].join(',')}
        onFiles={(f) => upload('stems', f)}
        button="Aggiungi tracce"
        tools={
          stems.length > 0 && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={removeSequence} title="Elimina tutte le tracce della sequenza">
              <Icon name="trash" size={13} /> Elimina sequenza
            </button>
          )
        }
        empty={!stems.length && !stemUploads.length && (canEdit ? 'Trascina qui gli stem (click, guide, basi…) o usa “Aggiungi tracce”.' : 'Nessuna traccia.')}
      >
        {stems.map((s, i) => (
          <StemRow
            key={s.id}
            stem={s}
            index={i}
            count={stems.length}
            canEdit={canEdit}
            cache={cache[s.path]}
            onPatch={(p) => patchStem(s.id, p)}
            onMove={(d) => moveStem(i, d)}
            onRemove={() => removeStem(s)}
          />
        ))}
        {stemUploads.map((u) => (
          <UploadRow key={u.key} upload={u} />
        ))}
      </Section>

      <Section
        title="Video"
        icon="video"
        canEdit={canEdit}
        accept={['video/*', ...VIDEO_EXTENSIONS.map((x) => `.${x}`)].join(',')}
        onFiles={(f) => upload('video', f)}
        button={video ? 'Sostituisci' : 'Carica video'}
        empty={!video && !videoUploads.length && (canEdit ? 'Trascina qui il video da proiettare in sincrono con la sequenza.' : 'Nessun video.')}
      >
        {video && (
          <div className="md-row role-video">
            <span className="swatch" />
            <span className="md-main">
              <span className="ellipsis" style={{ fontWeight: 600 }}>
                {video.name}
              </span>
              <span className="small faint ellipsis" title={video.file}>
                {video.file} · {formatBytes(video.size)}
              </span>
            </span>
            <label className="md-offset" title="Ritardo del video rispetto all’audio (negativo = in anticipo)">
              <span className="small faint">Offset</span>
              <input
                key={video.offset || 0}
                className="input se-tiny"
                type="number"
                step="0.01"
                defaultValue={video.offset || 0}
                disabled={!canEdit}
                onBlur={(e) => {
                  const offset = Number(e.target.value) || 0;
                  if (offset !== (video.offset || 0)) saveVideo(db, target, { ...video, offset }).catch(fail);
                }}
              />
              <span className="small faint">s</span>
            </label>
            <CacheState c={cache[video.path]} />
            {canEdit && (
              <button className="toggle" onClick={removeVideo} title="Elimina il video">
                <Icon name="trash" size={11} />
              </button>
            )}
          </div>
        )}
        {videoUploads.map((u) => (
          <UploadRow key={u.key} upload={u} />
        ))}
      </Section>

      <Section
        title="Spartito PDF"
        icon="file-text"
        canEdit={canEdit}
        accept="application/pdf,.pdf"
        onFiles={(f) => upload('score', f)}
        button={score ? 'Sostituisci' : 'Carica PDF'}
        empty={
          !score &&
          !scoreUploads.length &&
          (canEdit ? 'Trascina qui lo spartito: in Live, vista Spartito, lo sfogli con il pedale Bluetooth.' : 'Nessuno spartito.')
        }
      >
        {score && (
          <div className="md-row role-score">
            <span className="swatch" />
            <span className="md-main">
              <span className="ellipsis" style={{ fontWeight: 600 }}>
                {score.name}
              </span>
              <span className="small faint ellipsis" title={score.file}>
                {score.file} · {formatBytes(score.size)}
              </span>
            </span>
            <CacheState c={cache[score.path]} />
            {canEdit && (
              <button className="toggle" onClick={removeScore} title="Elimina lo spartito">
                <Icon name="trash" size={11} />
              </button>
            )}
          </div>
        )}
        {scoreUploads.map((u) => (
          <UploadRow key={u.key} upload={u} />
        ))}
      </Section>
    </div>
  );
}
