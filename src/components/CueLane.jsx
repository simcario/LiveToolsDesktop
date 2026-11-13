import { useMemo, useState } from 'react';
import { cueTrackOf, stemsOf } from '../shared/media.js';
import { useEngineStatus } from '../lib/engine';
import { editDraft } from '../lib/drafts';
import { COUNT_LABELS, cueBars, liveCuePlan, publishCueTrack, removeRenderedCues, renderCueTrack, sheetKey } from '../lib/cueTrack';
import { recordStep } from '../lib/arrangeHistory';
import Icon from './Icon';
import Meter from './Meter';

// Cue track of the Arrangement view (added with "Aggiungi → Traccia cue"):
// spoken cues ("Chorus", "Bridge", "One, two, three, four"…) drawn like a
// MIDI clip on the song's timeline, each bar split in 4 or 8 squares.
// Clicking a square picks the cue said there (CuePicker). The desktop plays
// them as a live track; "Mixdown" makes the "Cues" audio stem (guide role,
// a lane as the other audio tracks) that the web app plays too, and mutes
// the cue track for the whole band (cueTrack.muted).

export const CUE_COLOR = '#8b5cf6';

/** Cue sheet of the song in the player, its grid and the actions on it. */
export function useCueTrack({ player, setlistId, canEdit: canEditSetlist, notify }) {
  const [busy, setBusy] = useState(null); // text while rendering / uploading
  const loaded = player.loaded;
  const item = player.loadedItem;
  const canEdit = !!item && canEditSetlist && item.songEditable !== false;
  const exists = !!item?.cueTrack;
  const sheet = cueTrackOf(item);
  const { resolution, cues } = sheet;
  const tempo = loaded?.tempo;
  const duration = loaded?.duration || 0;
  const bars = useMemo(() => (tempo && duration ? cueBars(tempo, duration, resolution) : []), [tempo, duration, resolution]);
  const byG = useMemo(() => new Map(cues.map((c) => [c.g, c.label])), [cues]);

  // Played as a live track made from the sheet. The mixdown makes the "Cues"
  // audio track (heard on the web too) and mutes this one for the whole band.
  const rendered = stemsOf(item).find((s) => s.generated === 'cues');
  const fileUpToDate = !!rendered && sheet.renderedKey === sheetKey(cues);
  const muted = sheet.muted;
  const tracks = loaded?.tracks || [];
  const wantedLive = item ? liveCuePlan(item)?.stem.path ?? null : null;
  const heardLive = tracks.find((tr) => tr.stem.live)?.stem.path ?? null;
  const needsReload = !!loaded && wantedLive !== heardLive;
  // The live track playing the cues: mixed from the cue track header.
  const audioIndex = tracks.findIndex((tr) => tr.stem.live);
  const status = !cues.length
    ? canEdit
      ? 'Clicca un quadratino per inserire una cue'
      : 'Nessuna cue'
    : muted
      ? fileUpToDate
        ? 'Muta · suona la traccia audio “Cues”'
        : rendered
          ? 'Muta · traccia audio “Cues” da aggiornare (Mixdown)'
          : 'Muta'
      : rendered
        ? 'Live · suona anche la traccia audio “Cues”'
        : 'Live · solo desktop';

  // Every change of the cue sheet goes into the song's draft (saved with
  // "Salva") and can be undone (Ctrl+Z in the Arrangement). The audio file
  // "Cues" is created or deleted at once: only its sheet waits for "Salva".
  const write = (next, label = 'Cue modificate') => {
    recordStep(item.id, { label, before: { media: { cueTrack: item.cueTrack ?? null }, item: {} }, after: { media: { cueTrack: next }, item: {} } });
    editDraft(item.id, { media: { cueTrack: next } });
  };
  const save = (list) => write({ ...sheet, cues: [...list].sort((a, b) => a.g - b.g) });
  const add = () => write({ resolution: 4, cues: [], renderedKey: null }, 'Traccia cue aggiunta');
  const remove = async () => {
    const what = [cues.length && `le ${cues.length} cue`, rendered && 'il file audio “Cues” (anche dallo storage cloud)'].filter(Boolean).join(' e ');
    if (!confirm(`Rimuovere la traccia cue di “${item.title}”?${what ? ` Vengono eliminati ${what}.` : ''}`)) return;
    try {
      if (rendered) await removeRenderedCues(setlistId, item);
      write(null, 'Traccia cue rimossa');
    } catch (e) {
      notify(`Traccia cue non rimossa: ${e.message || e}`, true);
    }
  };
  const setCue = (g, label) => save([...cues.filter((c) => c.g !== g), ...(label ? [{ g, label }] : [])]);
  // One cue dragged to another square (wrong bar): it takes the place of the one there, if any.
  const moved = (from, to) => {
    const label = byG.get(from);
    return label == null || from === to ? cues : [...cues.filter((c) => c.g !== from && c.g !== to), { g: to, label }];
  };
  const moveCue = (from, to) => {
    if (from === to || !byG.has(from)) return;
    const over = byG.get(to);
    write({ ...sheet, cues: moved(from, to).sort((a, b) => a.g - b.g) }, over ? `Cue “${byG.get(from)}” al posto di “${over}”` : `Cue “${byG.get(from)}” spostata`);
  };
  // The whole track moved by `delta` beats (hand tool): cues out of the song are dropped.
  const lastG = bars.at(-1)?.cells.at(-1)?.g ?? 0;
  const shifted = (delta) => cues.map((c) => ({ ...c, g: c.g + delta })).filter((c) => c.g >= 0 && c.g <= lastG);
  const shift = (delta) => {
    if (!delta) return;
    const next = shifted(delta);
    const lost = cues.length - next.length;
    if (lost && !confirm(`${lost} cue finiscono fuori dal brano e vengono tolte. Continuare?`)) return;
    write({ ...sheet, cues: next.sort((a, b) => a.g - b.g) }, `Cue spostate di ${delta > 0 ? '+' : ''}${delta} movimenti`);
  };
  const countBar = (bar) => {
    const row = bars.find((b) => b.bar === bar);
    const beats = row.cells.filter((c) => !c.half).slice(0, COUNT_LABELS.length);
    const gs = new Set(beats.map((c) => c.g));
    save([...cues.filter((c) => !gs.has(c.g)), ...beats.map((c, i) => ({ g: c.g, label: COUNT_LABELS[i] }))]);
  };
  const setResolution = (r) => {
    if (r === resolution) return;
    const halves = cues.filter((c) => c.g % 1 !== 0).length;
    if (r === 4 && halves && !confirm(`${halves} cue sono sugli ottavi: passando ai quarti vengono spostate sul quarto precedente. Continuare?`)) return;
    const moved = r === 4 ? [...new Map(cues.map((c) => [Math.floor(c.g), { ...c, g: Math.floor(c.g) }])).values()] : cues;
    write({ ...sheet, resolution: r, cues: moved });
  };
  // Mute of the cue track for the whole band (saved with "Salva", undoable).
  const toggleMute = () => write({ ...item.cueTrack, muted: !muted }, muted ? 'Traccia cue riattivata' : 'Traccia cue mutata');
  // Mixdown: the cues become the "Cues" audio track (guide role, on the web too),
  // active, and the cue track is muted for everyone.
  const render = async () => {
    if (!cues.length) return;
    try {
      setBusy('Mixdown…');
      const blob = await renderCueTrack(cues, bars, duration);
      await publishCueTrack(setlistId, item, blob, (p, phase) => setBusy(`${phase === 'mp3' ? 'Conversione in MP3' : 'Caricamento'} ${Math.round(p * 100)}%`));
      editDraft(item.id, { media: { cueTrack: { ...item.cueTrack, renderedKey: sheetKey(cues), muted: true } } });
      notify(`Mixdown di “${item.title}”: traccia audio “Cues” ${rendered ? 'aggiornata' : 'creata'} e attiva (anche sul web), traccia cue mutata. “Salva” per tenerla mutata per tutta la band`);
    } catch (e) {
      notify(`Mixdown delle cue non riuscito: ${e.message || e}`, true);
    } finally {
      setBusy(null);
    }
  };
  const removeFile = async () => {
    if (!confirm(`Eliminare la traccia audio “Cues” di “${item.title}”, anche dallo storage cloud? Le cue restano e la traccia cue torna attiva.`)) return;
    try {
      setBusy('Eliminazione…');
      await removeRenderedCues(setlistId, item);
      editDraft(item.id, { media: { cueTrack: { ...item.cueTrack, renderedKey: null, muted: false } } });
      notify(`Eliminata la traccia audio “Cues” di “${item.title}”: si sente di nuovo la traccia cue`);
    } catch (e) {
      notify(`File audio non eliminato: ${e.message || e}`, true);
    } finally {
      setBusy(null);
    }
  };

  return {
    item,
    exists,
    canEdit,
    resolution,
    cues,
    bars,
    byG,
    rendered,
    fileUpToDate,
    muted,
    toggleMute,
    needsReload,
    audioIndex,
    status,
    busy,
    add,
    remove,
    setCue,
    shifted,
    shift,
    // One square in beats, and the squares of a bar (for the header buttons).
    cellStep: resolution === 8 ? 0.5 : 1,
    barBeats: (bars[0]?.cells.length || 4),
    moved,
    moveCue,
    countBar,
    setResolution,
    render,
    removeFile,
    reload: () => player.load(item),
  };
}

/** Square of the cue track at time t: { cell, beats } or null. */
export function cueCellAt(bars, t) {
  for (let r = 0; r < bars.length; r += 1) {
    const row = bars[r];
    for (let i = 0; i < row.cells.length; i += 1) {
      const c = row.cells[i];
      const end = row.cells[i + 1]?.t ?? bars[r + 1]?.cells[0]?.t ?? c.t + (c.t - (row.cells[i - 1]?.t ?? c.t - 0.5));
      if (t >= c.t && t < end) return { cell: { ...c, bar: row.bar }, beats: row.cells.filter((x) => !x.half).length };
    }
  }
  return null;
}

/** Draws the cue track: a clip like the audio ones, squares per beat or eighth. */
export function drawCueLane(ctx, opts) {
  // Muted (after the mixdown): drawn faded, as a muted audio clip.
  ctx.save();
  if (opts.muted) ctx.globalAlpha = 0.45;
  drawCueClip(ctx, opts);
  ctx.restore();
}

function drawCueClip(ctx, { y, h, width, x, bars, byG, status, hover, nowG }) {
  const first = bars[0]?.cells[0];
  const lastRow = bars.at(-1);
  if (!first || !lastRow) return;
  const cellsOf = (r) => bars[r]?.cells || [];
  const lastCell = lastRow.cells.at(-1);
  const step = lastRow.cells.length > 1 ? lastRow.cells[1].t - lastRow.cells[0].t : 0.5;
  const cx = x(first.t);
  const cw = x(lastCell.t + step) - cx;
  ctx.fillStyle = `${CUE_COLOR}24`;
  ctx.fillRect(cx, y + 3, cw, h - 6);
  // Header strip as on the audio clips, with a "CUE" badge.
  ctx.fillStyle = CUE_COLOR;
  ctx.fillRect(cx, y + 3, cw, 14);
  ctx.save();
  ctx.beginPath();
  ctx.rect(Math.max(cx, 0), y + 3, Math.min(cw, width), 14);
  ctx.clip();
  const lx = Math.max(cx, 0) + 5;
  ctx.fillStyle = '#0b0f17';
  ctx.fillRect(lx, y + 5, 26, 10);
  ctx.font = '800 8px Inter, sans-serif';
  ctx.fillStyle = '#c4b5fd';
  ctx.fillText('CUE', lx + 4, y + 10.5);
  ctx.font = '700 10px Inter, sans-serif';
  ctx.fillStyle = '#0b0f17';
  ctx.fillText(status, lx + 32, y + 10.5);
  ctx.restore();

  const top = y + 20;
  const ch = h - 26;
  ctx.font = '600 10px Inter, sans-serif';
  bars.forEach((row, r) => {
    row.cells.forEach((c, i) => {
      const end = row.cells[i + 1]?.t ?? cellsOf(r + 1)[0]?.t ?? c.t + step;
      const x0 = x(c.t);
      const x1 = x(end);
      if (x1 < 0 || x0 > width) return;
      const w = x1 - x0;
      const label = byG.get(c.g);
      if (w >= 5 || label) {
        ctx.fillStyle = label ? `${CUE_COLOR}e0` : hover === c.g ? `${CUE_COLOR}66` : c.half ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.055)';
        ctx.fillRect(x0 + 1, top, Math.max(1, w - 2), ch);
      }
      if (c.beat === 0 && !c.half) {
        ctx.fillStyle = 'rgba(196,181,253,0.4)';
        ctx.fillRect(Math.round(x0), top, 1, ch);
      }
      if (nowG === c.g) {
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + 1, top + 1, Math.max(1, w - 2), ch - 2);
        ctx.lineWidth = 1;
      }
      if (label) {
        // The name may run over the next empty squares (up to 8).
        let tEnd = end;
        const after = [...row.cells.slice(i + 1), ...cellsOf(r + 1)];
        for (let k = 0; k < after.length && k < 8; k += 1) {
          if (byG.has(after[k].g)) break;
          tEnd = after[k + 1]?.t ?? after[k].t + step;
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 + 1, top, Math.max(w - 2, x(tEnd) - x0 - 2), ch);
        ctx.clip();
        ctx.fillStyle = '#f5f3ff';
        ctx.fillText(label, x0 + 4, top + ch / 2);
        ctx.restore();
      }
    });
  });
}

/** Header of the cue track: mix of its audio, resolution, render, remove. */
export function CueHeader({ cue, solos, onTrack, loadedTracks, onMenu }) {
  const track = cue.audioIndex >= 0 ? loadedTracks[cue.audioIndex] : null;
  const stem = track?.stem;
  return (
    <div className="t-header t-header-cue" style={{ '--lane-color': CUE_COLOR }} onContextMenu={onMenu}>
      <span className="t-color" />
      <span className="t-name" title="Traccia cue: guide vocali sulle battute">
        <span className="cue-badge">CUE</span> Cues
      </span>
      <span className="t-btns">
        <button
          className="toggle"
          disabled={!cue.canEdit}
          onClick={() => cue.setResolution(cue.resolution === 8 ? 4 : 8)}
          title="Quadratini per battuta: quarti o ottavi"
        >
          {cue.resolution === 8 ? '1/8' : '1/4'}
        </button>
        {cue.canEdit && cue.cues.length > 0 && (
          <>
            <button className="toggle" onClick={(e) => cue.shift(-(e.shiftKey ? cue.barBeats : 1) * cue.cellStep)} title="Sposta tutte le cue indietro di un quadratino (Maiusc: di una battuta)">
              ‹
            </button>
            <button className="toggle" onClick={(e) => cue.shift((e.shiftKey ? cue.barBeats : 1) * cue.cellStep)} title="Sposta tutte le cue avanti di un quadratino (Maiusc: di una battuta)">
              ›
            </button>
          </>
        )}
        {cue.cues.length > 0 && (
          <button
            className={`toggle mute ${cue.muted ? 'is-on' : ''}`}
            disabled={!cue.canEdit}
            onClick={cue.toggleMute}
            title={cue.muted ? 'Traccia cue muta per tutta la band (dopo il Mixdown suona la traccia audio “Cues”): clicca per riattivarla' : 'Muta la traccia cue per tutta la band'}
          >
            M
          </button>
        )}
        {stem && (
          <button className={`toggle solo ${solos[stem.id] ? 'is-on' : ''}`} onClick={() => onTrack(stem, { solo: !solos[stem.id] })}>
            S
          </button>
        )}
      </span>
      <div className="t-row">
        {/* Volume of the cue track: in the Mixer (Dettaglio → Mixer, F3). */}
        <span className="small muted ellipsis grow">
          {cue.busy || (cue.cues.length ? (cue.needsReload ? 'Aggiorno le cue…' : '') : 'Nessuna cue')}
        </span>
        {cue.needsReload && (
          <button className="toggle" onClick={cue.reload} disabled={!!cue.busy} title="Ricarica il brano nel player per ascoltare le cue aggiornate">
            <Icon name="undo" size={11} />
          </button>
        )}
        {cue.canEdit && (
          <button
            className={`toggle ${cue.rendered && !cue.fileUpToDate ? 'is-on' : ''}`}
            onClick={cue.render}
            disabled={!cue.cues.length || !!cue.busy || cue.fileUpToDate}
            title={
              cue.fileUpToDate
                ? 'Mixdown già fatto: la traccia audio “Cues” è aggiornata'
                : cue.rendered
                  ? 'Mixdown: aggiorna la traccia audio “Cues” (anche per il web) e muta la traccia cue'
                  : 'Mixdown: crea la traccia audio “Cues” (si sente anche sul web) e muta la traccia cue'
            }
          >
            <Icon name="wand" size={11} /> Mixdown
          </button>
        )}
        {cue.canEdit && cue.rendered && (
          <button className="toggle" onClick={cue.removeFile} disabled={!!cue.busy} title="Elimina la traccia audio “Cues”: la traccia cue torna attiva">
            <Icon name="cloud" size={11} />
          </button>
        )}
        {cue.canEdit && (
          <button className="toggle" onClick={cue.remove} disabled={!!cue.busy} title="Rimuovi la traccia cue (cue e file audio)">
            <Icon name="trash" size={11} />
          </button>
        )}
        {track && <Meter track={cue.audioIndex} horizontal />}
      </div>
    </div>
  );
}

/** Square of the cue track playing now (for the highlight), or null. */
export function useNowCue(bars, songId) {
  const cells = useMemo(() => bars.flatMap((b) => b.cells), [bars]);
  return useEngineStatus((s) => {
    if (!s.playing || s.songId !== songId) return null;
    let lo = 0;
    let hi = cells.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cells[mid].t <= s.position + 0.005) {
        found = cells[mid].g;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  });
}
