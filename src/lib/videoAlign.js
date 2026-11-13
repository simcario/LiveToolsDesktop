// "Sincronizza": where a song's video starts, found by matching the sound of the
// video file against the multitrack as the engine plays it (regions included),
// in Rust (audio/align.rs). The result is video.offset: seconds of the song where
// the video starts (negative = it starts before the song, its first part is cut).
import { invoke } from '@tauri-apps/api/core';
import { isVideoItem, regionsOf, stemsOf, videoOf } from '../shared/media.js';
import { downloadError, ensureFile } from './mediaCache';

// Below this the match is uncertain (a repetitive song, a video with other sound…).
const SURE = 0.1;

/** The stems heard in the video's sound: the PA ones; without them, all but the click. */
function alignStems(item) {
  const all = stemsOf(item);
  const main = all.filter((s) => (s.role || 'main') === 'main');
  return main.length ? main : all.filter((s) => s.role !== 'click');
}

/** A song (not a video item) with a video and stems to compare it with. */
export const canAlignVideo = (item) => !!item && !isVideoItem(item) && !!videoOf(item) && alignStems(item).length > 0;

/**
 * { offset, confidence, sure } for the video of `item`; downloads the files it needs.
 * `videoLocal`: the video's path on disk when already known (just uploaded).
 */
export async function alignVideo(item, videoLocal = null) {
  const video = videoOf(item);
  if (!video) throw new Error('il brano non ha un video');
  const stems = alignStems(item);
  if (!stems.length) throw new Error('il brano non ha tracce audio con cui confrontarlo');
  const [local, ...paths] = await Promise.all([videoLocal || ensureFile({ path: video.path, size: video.size }), ...stems.map((s) => ensureFile({ path: s.path, size: s.size }))]);
  if (!local) throw new Error(`video non scaricato${downloadError(video.path) ? ` (${downloadError(video.path)})` : ''}`);
  const regions = regionsOf(item);
  const placed = (id) => (Array.isArray(regions[id]) ? regions[id] : []).map((r) => ({ at: Number(r.at) || 0, from: Number(r.from) || 0, len: r.len ?? null, muted: !!r.muted }));
  const list = stems.map((s, i) => ({ path: paths[i], regions: placed(s.id) })).filter((s) => s.path);
  if (!list.length) throw new Error('tracce non scaricate');
  const res = await invoke('align_video', { request: { video: local, stems: list } });
  return { ...res, sure: res.confidence >= SURE };
}

const secs = (s) => `${Math.abs(s).toFixed(2).replace('.', ',')} s`;

/** Text for the status bar after a sync. */
export function alignText(title, { offset, sure }) {
  const where = Math.abs(offset) < 0.005 ? 'parte insieme al brano' : offset > 0 ? `parte ${secs(offset)} dopo l’inizio del brano` : `parte ${secs(offset)} prima del brano (l’inizio del video non si vede)`;
  return `Video di “${title}” sincronizzato: ${where}${sure ? '' : ' · corrispondenza incerta, controlla e correggi l’offset a mano se serve'}`;
}
