// Controllo pre-concerto: before the show, one press checks what can go wrong
// on stage — the files of the setlist on disk, the audio interface and its
// outputs, the pedal, the MIDI ports, the space on disk, the video output, the
// edits not saved. Each check gives ok / warn / error and, where it helps, the
// button that fixes it.
import { invoke } from '@tauri-apps/api/core';
import { isSeparator } from '../shared/setlists.js';
import { isLocalPath, videoOf } from '../shared/media.js';
import { scoreOf } from '../shared/score.js';
import { isDirty } from './drafts';
import { engineStatus } from './engine';
import { mediaOf, missingFiles } from './mediaCache';
import { midiOutputs, midiTargeted } from './midi';
import { routePatches } from '../shared/midi-patch.js';
import { OUTPUT_ROLES } from './settings';

const GB = 1024 ** 3;
// Space left free on top of what is still to download (key and tempo changes, cues).
const DISK_MARGIN = 2 * GB;

export const formatBytes = (n) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const names = (list, max = 3) => list.slice(0, max).join(', ') + (list.length > max ? ` e altri ${list.length - max}` : '');

/** Outputs (1-based, as on the interface) a route needs: 'off' needs none. */
const lastChannel = (r) => (!r || r.mode === 'off' ? 0 : (r.start || 0) + (r.mode === 'mono' ? 1 : 2));

function filesCheck(songs, cache) {
  const missing = [];
  const local = [];
  const failed = [];
  songs.forEach((s) => {
    const files = missingFiles(mediaOf(s));
    if (!files.length) return;
    if (files.some((f) => isLocalPath(f.path))) local.push(s.title);
    else if (files.some((f) => cache[f.path]?.error)) failed.push(s.title);
    else missing.push(s.title);
  });
  const empty = songs.filter((s) => !mediaOf(s).length && s.playback !== 'video').map((s) => s.title);
  if (local.length)
    return { status: 'error', detail: `${plural(local.length, 'brano ha', 'brani hanno')} file aggiunti solo su un altro dispositivo: ${names(local)}. Caricali da lì o sostituiscili.`, songs: local };
  if (failed.length) return { status: 'error', detail: `Download non riuscito per ${names(failed)}.`, action: 'download', songs: failed };
  if (missing.length) return { status: 'warn', detail: `Da scaricare: ${names(missing)}. Senza internet sul palco non suonerebbero.`, action: 'download', songs: missing };
  if (empty.length) return { status: 'warn', detail: `Tutto scaricato, ma ${plural(empty.length, 'brano è', 'brani sono')} senza tracce audio: ${names(empty)}.` };
  return { status: 'ok', detail: `Tutti i file dei ${plural(songs.length, 'brano', 'brani')} sono su questo computer.` };
}

function audioCheck(device, settings) {
  if (!device) return { status: 'warn', detail: 'La scheda audio si sta ancora aprendo.' };
  if (device.error) return { status: 'error', detail: `La scheda audio non si apre: ${device.error}`, action: 'audio' };
  const info = device.info;
  if (settings.audioDevice && info.name !== settings.audioDevice && !settings.audioDevice.endsWith(info.name))
    return { status: 'error', detail: `“${settings.audioDevice}” non è collegata: l’audio esce da “${info.name}”.`, action: 'audio' };
  const short = OUTPUT_ROLES.filter(([role]) => lastChannel(settings.outputs[role]) > info.channels).map(([, label]) => label);
  if (short.length)
    return { status: 'error', detail: `${info.name} ha ${info.channels} uscite: ${names(short)} ${short.length === 1 ? 'va' : 'vanno'} su uscite che non ci sono.`, action: 'audio' };
  const underruns = engineStatus().underruns || 0;
  if (underruns > 0) return { status: 'warn', detail: `${info.name} funziona, ma ci sono stati ${underruns} dropout: prova un buffer più grande.`, action: 'audio' };
  return { status: 'ok', detail: `${info.name} · ${info.sampleRate / 1000} kHz · ${info.channels} uscite.` };
}

async function pedalCheck(songs) {
  const withScore = songs.filter((s) => scoreOf(s));
  if (!withScore.length) return { status: 'skip', detail: 'Nessun brano ha uno spartito: il pedale non serve.' };
  try {
    const list = await invoke('bluetooth_devices');
    const pedal = list.find((d) => d.input);
    if (pedal) return { status: 'ok', detail: `“${pedal.name}” collegato. Premilo una volta per svegliarlo.` };
    return { status: 'warn', detail: `${plural(withScore.length, 'brano ha', 'brani hanno')} uno spartito ma nessun pedale Bluetooth è collegato (un pedale USB funziona lo stesso).`, action: 'pedal' };
  } catch {
    return { status: 'skip', detail: 'Elenco Bluetooth non disponibile qui: prova il pedale girando una pagina.' };
  }
}

async function midiCheck(songs, midi) {
  const withMidi = songs.filter((s) => s.midi?.length);
  if (!withMidi.length) return { status: 'skip', detail: 'Nessun brano invia patch MIDI.' };
  if (!midiTargeted(midi)) return { status: 'warn', detail: `${plural(withMidi.length, 'brano ha', 'brani hanno')} patch MIDI, ma nessuna uscita MIDI è scelta.`, action: 'midi' };
  let ports = [];
  try {
    ports = await midiOutputs();
  } catch (e) {
    return { status: 'error', detail: `Uscite MIDI non leggibili: ${e?.message || e}` };
  }
  const needed = new Set(withMidi.flatMap((s) => Object.keys(routePatches(s.midi, midi?.output, midi?.routes))));
  const absent = [...needed].filter((p) => !ports.includes(p));
  if (absent.length) return { status: 'error', detail: `Non collegata: ${names(absent)}. Le patch non arriverebbero alle tastiere.`, action: 'midi' };
  return { status: 'ok', detail: `${plural(needed.size, 'uscita collegata', 'uscite collegate')}: ${names([...needed])}.` };
}

async function diskCheck(songs, cache) {
  let space = null;
  try {
    space = await invoke('disk_space');
  } catch {
    // older build: no check
  }
  if (!space) return { status: 'skip', detail: 'Spazio su disco non leggibile qui.' };
  const toDownload = songs
    .flatMap((s) => missingFiles(mediaOf(s)))
    .reduce((sum, f) => sum + Math.max(0, (f.size || cache[f.path]?.total || 0) - (cache[f.path]?.received || 0)), 0);
  const free = space.free;
  if (free < toDownload) return { status: 'error', detail: `Liberi ${formatBytes(free)}, ma servono ${formatBytes(toDownload)} per i file da scaricare.`, action: 'media' };
  if (free < toDownload + DISK_MARGIN) return { status: 'warn', detail: `Restano solo ${formatBytes(free - toDownload)} liberi dopo i download.`, action: 'media' };
  return { status: 'ok', detail: `${formatBytes(free)} liberi${toDownload ? ` (${formatBytes(toDownload)} da scaricare)` : ''}.` };
}

function videoCheck(songs, videoOpen, ndiOn) {
  const withVideo = songs.filter((s) => videoOf(s));
  if (!withVideo.length) return { status: 'skip', detail: 'Nessun brano ha un video.' };
  if (videoOpen || ndiOn) return { status: 'ok', detail: `Uscita video ${videoOpen ? 'aperta' : 'via rete (NDI)'} per ${plural(withVideo.length, 'brano', 'brani')}.` };
  return { status: 'warn', detail: `${plural(withVideo.length, 'brano ha', 'brani hanno')} un video, ma l’uscita video è chiusa.`, action: 'video' };
}

function draftsCheck(songs) {
  const dirty = songs.filter((s) => isDirty(s.id)).map((s) => s.title);
  if (!dirty.length) return { status: 'ok', detail: 'Nessuna modifica in sospeso.' };
  return { status: 'warn', detail: `Modifiche dell’Arrangement non salvate in ${names(dirty)}: gli altri musicisti non le hanno.` };
}

function networkCheck(settings, net) {
  const online = navigator.onLine;
  const lan = settings.stageNet?.enabled;
  const peers = net?.peers?.length ?? null;
  if (!online && !lan) return { status: 'warn', detail: 'Niente internet e rete locale di palco spenta: gli altri dispositivi non ti seguiranno.' };
  const parts = [online ? 'Internet ok' : 'Niente internet (si suona lo stesso: i file sono sul computer)'];
  if (lan) parts.push(peers ? `${plural(peers, 'dispositivo', 'dispositivi')} sulla rete di palco` : 'rete di palco accesa');
  return { status: online ? 'ok' : 'warn', detail: parts.join(' · ') + '.' };
}

export const CHECKS = [
  ['files', 'File dei brani'],
  ['audio', 'Scheda audio e uscite'],
  ['disk', 'Spazio su disco'],
  ['midi', 'Tastiere MIDI'],
  ['pedal', 'Pedale dello spartito'],
  ['video', 'Uscita video'],
  ['drafts', 'Modifiche non salvate'],
  ['network', 'Rete'],
];

/**
 * Runs every check: { [id]: { status, detail, action?, songs? } }.
 * ctx: { items, cache, device, settings, videoOpen, net }.
 */
export async function runPreflight({ items, cache, device, settings, videoOpen, net }) {
  const songs = items.filter((i) => !isSeparator(i));
  const [pedal, midi, disk] = await Promise.all([pedalCheck(songs), midiCheck(songs, settings.midi), diskCheck(songs, cache)]);
  return {
    files: filesCheck(songs, cache),
    audio: audioCheck(device, settings),
    disk,
    midi,
    pedal,
    video: videoCheck(songs, videoOpen, settings.ndi?.video?.enabled),
    drafts: draftsCheck(songs),
    network: networkCheck(settings, net),
  };
}

/** The worst status: 'error' > 'warn' > 'ok'. */
export function overall(results) {
  const st = Object.values(results || {}).map((r) => r.status);
  if (st.includes('error')) return 'error';
  if (st.includes('warn')) return 'warn';
  return 'ok';
}
