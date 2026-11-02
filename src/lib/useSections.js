// Sections of the song in the player, shared by the Palco view, the section
// lane of the Arrangement and the "Sezioni" tab of the sidebar. Edits go into
// the song's draft, as those of the Arrangement (lib/drafts.js).
import { useMemo, useState } from 'react';
import { cueTrackOf } from '../shared/media.js';
import { clearHistory, recordStep, travel, useHistory } from './arrangeHistory';
import { discardDraft, draftOf, editDraft, saveDraft, useDrafts } from './drafts';
import { engineStatus } from './engine';
import { addMarker, jumpToSection, moveMarker, nearestBarIndex, removeMarker, renameMarker, sectionTiming, songBars, songBeats, songSections } from './sections';

export function useSections({ player, setlistId, canEdit, notify, quant }) {
  const loaded = player.loaded;
  const song = player.loadedItem;
  const tempo = loaded?.tempo;
  const duration = loaded?.duration || 0;
  const beats = useMemo(() => songBeats(tempo, duration), [tempo, duration]);
  const bars = useMemo(() => songBars(beats), [beats]);
  const sections = useMemo(() => songSections(song, beats, duration), [song, beats, duration]);
  const editable = !!song && !!canEdit && song.songEditable !== false;
  const dirty = !!useDrafts()[song?.id];
  const history = useHistory(song?.id);
  const [saving, setSaving] = useState(false);

  // False when refused: the cues are placed on the grid, and a section with its
  // own tempo or metre would move the grid under them.
  const commit = (list, label) => {
    if (cueTrackOf(song).cues.length && JSON.stringify(sectionTiming({ ...song, sections: list })) !== JSON.stringify(sectionTiming(song))) {
      notify?.('Questa modifica cambierebbe il tempo del brano e sposterebbe le cue: per le sezioni con tempo o metro propri usa la pagina Scaletta', true);
      return false;
    }
    const before = { media: {}, item: { sections: song.sections ?? null } };
    const after = { media: {}, item: { sections: list } };
    editDraft(song.id, after);
    recordStep(song.id, { label, before, after });
    return true;
  };

  /** New marker on a bar: the index of its section, or null. */
  const add = (bar) => {
    const res = editable && bars[bar] ? addMarker(song, bar, bars.length) : null;
    if (!res) return null;
    return commit(res.sections, `Sezione aggiunta alla battuta ${bars[bar].bar}`) ? res.index : null;
  };

  return {
    beats,
    bars,
    sections,
    editable,
    dirty,
    saving,
    canUndo: history.past.length > 0,
    undoLabel: history.past.at(-1)?.label,
    canRedo: history.future.length > 0,
    redoLabel: history.future.at(-1)?.label,
    add,
    /** New marker on the bar nearest to the playhead. */
    addAtPlayhead: () => {
      const bar = nearestBarIndex(bars, Math.max(0, engineStatus().position));
      const index = add(bar);
      if (index == null && sections.some((s) => s.barIndex === bar)) notify?.(`C’è già una sezione alla battuta ${bars[bar].bar}`);
      return index;
    },
    /** The marker moved on a bar: its new index, or null. */
    move: (index, bar) => {
      const res = moveMarker(song, index, bar);
      return res && commit(res.sections, 'Sezione spostata') ? res.index : null;
    },
    rename: (index, label) => commit(renameMarker(song, index, label), `Sezione rinominata in “${label}”`),
    remove: (index) => commit(removeMarker(song, index), 'Sezione eliminata'),
    go: (s) => jumpToSection(s, quant, beats, sections),
    /** Undo (dir -1) or redo (dir 1) of the last edit of the song, whatever view it was made in. */
    travel: async (dir) => {
      const res = await travel(song, dir);
      if (res && (res.step.reload || Object.keys(res.step.after.media).length)) player.reload();
    },
    save: async () => {
      setSaving(true);
      try {
        await saveDraft(setlistId, song);
        notify?.(`Salvato “${song.title}”`);
      } catch (e) {
        notify?.(`“${song.title}” non salvato: ${e.message || e}`, true);
      } finally {
        setSaving(false);
      }
    },
    discard: () => {
      if (!confirm(`Scartare le modifiche non salvate di “${song.title}”? Torna com’era all’ultimo salvataggio.`)) return false;
      const d = draftOf(song.id);
      const others = Object.keys(d?.media || {}).length > 0 || Object.keys(d?.item || {}).some((k) => k !== 'sections');
      discardDraft(song.id);
      clearHistory(song.id);
      // Only the sections changed: the tempo map follows by itself and the music goes on.
      if (others) player.reload();
      return true;
    },
  };
}
