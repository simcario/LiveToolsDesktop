import { useMemo, useState } from 'react';
import { cueTrackOf, stemsOf } from '../shared/media.js';
import { useEngineStatus } from '../lib/engine';
import { editDraft } from '../lib/drafts';
import { COUNT_LABELS, cueBars, liveCuePlan, publishCueTrack, removeRenderedCues, renderCueTrack, sheetKey } from '../lib/cueTrack';
import { recordStep } from '../lib/arrangeHistory';
import { getMix } from '../lib/settings';
import Icon from './Icon';
import Meter from './Meter';

// Cue track of the Arrangement view (added with "Aggiungi → Traccia cue"):
// spoken cues ("Chorus", "Bridge", "One, two, three, four"…) drawn like a
// MIDI clip on the song's timeline, each bar split in 4 or 8 squares.
// Clicking a square picks the cue said there (CuePicker). The desktop plays
// them as a live track; "Renderizza" makes the "Cues" audio stem (guide
// role) that the web app and the other computers play too.

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

  // Heard on this desktop as a live track until rendered into the audio file.
  const rendered = stemsOf(item).find((s) => s.generated === 'cues');
  const fileUpToDate = !!rendered && sheet.renderedKey === sheetKey(cues);
  const tracks = loaded?.tracks || [];
  const wantedLive = item ? liveCuePlan(item)?.stem.path ?? null : null;
  const heardLive = tracks.find((tr) => tr.stem.live)?.stem.path ?? null;
  const needsReload = !!loaded && (wantedLive !== heardLive || (fileUpToDate && !tracks.some((tr) => tr.stem.id === rendered.id)));
  // The audio track playing the cues: mixed from the cue track header.
  const audioIndex = tracks.findIndex((tr) => tr.stem.live || tr.stem.generated === 'cues');
  const status = !cues.length
    ? canEdit
      ? 'Clicca un quadratino per inserire una cue'
      : 'Nessuna cue'
    : fileUpToDate
      ? 'File audio · anche sul web'
      : rendered
        ? 'File da aggiornare · ora live'
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
    const what = [cues.length && `le ${cues.length} cue`, rendered && 'il file audio “Cues”'].filter(Boolean).join(' e ');
    if (!confirm(`Rimuovere la traccia cue di “${item.title}”?${what ? ` Vengono eliminati ${what}.` : ''}`)) return;
    try {
      if (rendered) await removeRenderedCues(setlistId, item);
      write(null, 'Traccia cue rimossa');
    } catch (e) {
      notify(`Traccia cue non rimossa: ${e.message || e}`, true);
    }
  };
  const setCue = (g, label) => save([...cues.filter((c) => c.g !== g), ...(label ? [{ g, label }] : [])]);
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
  const render = async () => {
    if (!cues.length) return;
    try {
      setBusy('Creazione…');
      const blob = await renderCueTrack(cues, bars, duration);
      await publishCueTrack(setlistId, item, blob, (p) => setBusy(`Caricamento ${Math.round(p * 100)}%`));
      editDraft(item.id, { media: { cueTrack: { ...sheet, renderedKey: sheetKey(cues) } } });
      notify(`File audio “Cues” di “${item.title}” ${rendered ? 'aggiornato' : 'creato'}: ora si sente anche sul web`);
    } catch (e) {
      notify(`File audio delle cue non creato: ${e.message || e}`, true);
    } finally {
      setBusy(null);
    }
  };
  const removeFile = async () => {
    if (!confirm(`Eliminare il file audio “Cues” di “${item.title}”? Le cue restano: sul desktop si sentono come traccia live, sul web non più.`)) return;
    try {
      setBusy('Eliminazione…');
      await removeRenderedCues(setlistId, item);
      editDraft(item.id, { media: { cueTrack: { ...sheet, renderedKey: null } } });
      notify(`Eliminato il file audio “Cues” di “${item.title}”`);
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
    needsReload,
    audioIndex,
    status,
    busy,
    add,
    remove,
    setCue,
    shifted,
    shift,
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
export function drawCueLane(ctx, { y, h, width, x, bars, byG, status, hover, nowG }) {
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
export function CueHeader({ cue, solos, onTrack, loadedTracks }) {
  const track = cue.audioIndex >= 0 ? loadedTracks[cue.audioIndex] : null;
  const stem = track?.stem;
  const m = stem ? getMix(stem.id) : {};
  const mute = stem ? m.mute ?? !!stem.muted : false;
  const gain = stem ? m.gainDb ?? stem.gain ?? 0 : 0;
  return (
    <div className="t-header t-header-cue" style={{ '--lane-color': CUE_COLOR }}>
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
        {stem && (
          <>
            <button className={`toggle mute ${mute ? 'is-on' : ''}`} onClick={() => onTrack(stem, { mute: !mute })}>
              M
            </button>
            <button className={`toggle solo ${solos[stem.id] ? 'is-on' : ''}`} onClick={() => onTrack(stem, { solo: !solos[stem.id] })}>
              S
            </button>
          </>
        )}
      </span>
      <div className="t-row">
        {stem && !cue.busy ? (
          <input
            className="slider"
            type="range"
            min={-60}
            max={6}
            step={0.5}
            value={gain}
            onChange={(e) => onTrack(stem, { gainDb: Number(e.target.value) })}
            onDoubleClick={() => onTrack(stem, { gainDb: 0 })}
            title={`${gain.toFixed(1)} dB`}
          />
        ) : (
          <span className="small muted ellipsis grow">
            {cue.busy || (cue.cues.length ? (cue.needsReload ? 'Aggiorno le cue…' : '') : 'Nessuna cue')}
          </span>
        )}
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
            title={cue.rendered ? 'Aggiorna il file audio “Cues” (anche per il web)' : 'Renderizza in file audio: lo stem “Cues” si sente anche sul web'}
          >
            <Icon name="wand" size={11} />
          </button>
        )}
        {cue.canEdit && cue.rendered && (
          <button className="toggle" onClick={cue.removeFile} disabled={!!cue.busy} title="Elimina il file audio: le cue restano come traccia live">
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
