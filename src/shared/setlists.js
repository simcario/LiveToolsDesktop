import { serverTimestamp } from 'firebase/firestore';

export const COLUMN_TYPES = {
  checkbox: 'Sì / No',
  toggle: 'Switch (2 valori)',
  select: 'Menu a tendina',
  url: 'Link URL',
  note: 'Note',
  text: 'Testo breve',
};

export const DEFAULT_TOGGLE_OPTIONS = ['Valore A', 'Valore B'];

// Toggle columns store a boolean: false = options[0] (default), true = options[1].
export function toggleOptions(column) {
  const o = column.options || [];
  return [o[0] || DEFAULT_TOGGLE_OPTIONS[0], o[1] || DEFAULT_TOGGLE_OPTIONS[1]];
}

export function newId() {
  return Math.random().toString(36).slice(2, 10);
}

// Select columns: choices are [{ id, label }] and items store the choice id,
// so renaming a choice keeps existing values.
export function defaultChoices(seed = ['Opzione 1', 'Opzione 2', 'Opzione 3']) {
  return seed.map((label) => ({ id: newId(), label }));
}

export function selectChoices(column) {
  return column.choices || [];
}

export function choiceLabel(column, value) {
  return selectChoices(column).find((c) => c.id === value)?.label ?? '';
}

export function defaultColumns() {
  return [
    { id: newId(), name: 'Fatto', type: 'checkbox', visible: true },
    { id: newId(), name: 'Link', type: 'url', visible: true },
    { id: newId(), name: 'Note', type: 'note', visible: false },
  ];
}

export function normalizeEmail(e) {
  return (e || '').trim().toLowerCase();
}

export function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Only http(s) links are rendered; bare domains get https:// prepended.
export function safeUrl(value) {
  const v = (value || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  return `https://${v}`;
}

// Fields to write whenever sharing lists change; `members` backs the
// "shared with me" query and the read rule.
export function membershipUpdate(editors, viewers, stage) {
  const e = [...new Set(editors)];
  const s = [...new Set(stage)].filter((x) => !e.includes(x));
  const v = [...new Set(viewers)].filter((x) => !e.includes(x) && !s.includes(x));
  return { editors: e, stage: s, viewers: v, members: [...e, ...s, ...v], updatedAt: serverTimestamp() };
}

export function getRole(setlist, uid, email, isToolAdmin) {
  if (!setlist) return null;
  if (setlist.ownerUid === uid) return 'owner';
  if (isToolAdmin) return 'admin';
  if ((setlist.editors || []).includes(email)) return 'editor';
  if ((setlist.stage || []).includes(email)) return 'stage';
  if ((setlist.viewers || []).includes(email)) return 'viewer';
  return null;
}

// Roles a setlist owner can assign, in order of power.
export const SHARE_ROLES = ['editor', 'stage', 'viewer'];

export const ROLE_LABELS = {
  owner: 'Proprietario',
  admin: 'Amministratore',
  editor: 'Può modificare',
  stage: 'Palco',
  viewer: 'Sola lettura',
};

export const ROLE_HINTS = {
  editor: 'Modifica brani, colonne e valori',
  stage: 'Vede la scaletta, segna i brani completati e può guidare il palco',
  viewer: 'Vede la scaletta senza modificarla',
};

// ---------- Built-in song fields ----------
// Every song has these fields (stored at the top level of the item, next to
// the custom column values). Separators have `kind` and an optional duration.

export const PLAYBACK_TYPES = {
  sequence: { label: 'Sequenza', hint: 'Multitraccia completa con stem' },
  backing: { label: 'Solo base', hint: 'Base semplice o click' },
  live: { label: 'Live puro', hint: 'Nessun playback: metronomo e patch MIDI' },
};

export const BREAK_KINDS = {
  section: { label: 'Separatore', icon: 'minus' },
  pause: { label: 'Pausa / Intermezzo', icon: 'coffee' },
  speech: { label: 'Presentazione / Discorso', icon: 'mic' },
};

export const TIME_SIGNATURES = ['4/4', '3/4', '6/8', '2/4', '5/4', '7/8', '12/8'];

export const isSeparator = (it) => it?.type === 'separator';

export const CLICK_MODES = { full: 'Full track', click: 'Solo click', guide: 'Guide vocali' };

// "4:15", "4.15", "255" (seconds) or "4m" → seconds. Empty/invalid → null.
export function parseDuration(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  let m = v.match(/^(\d{1,3})[:.,](\d{1,2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = v.match(/^(\d{1,3})\s*m(?:in)?$/i);
  if (m) return Number(m[1]) * 60;
  m = v.match(/^\d+$/);
  if (m) return Number(v) >= 20 ? Number(v) : Number(v) * 60; // "5" means 5 minutes
  return null;
}

export function formatDuration(sec) {
  if (!sec && sec !== 0) return '';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// 6480 → "1h 48m", 2520 → "42m"
export function formatLong(sec) {
  if (!sec) return '0m';
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

export function totalDuration(items) {
  return items.reduce((sum, it) => sum + (Number(it.duration) || 0), 0);
}

// Stats denormalized on the setlist document, shown in the lists.
export function setlistStats(items) {
  const songs = items.filter((it) => !isSeparator(it));
  return { songs: songs.length, duration: totalDuration(items) };
}

export function formatClock(date) {
  return date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

// Show start (event date + start time) as a Date, or null.
export function eventStart(event) {
  if (!event?.date) return null;
  const d = new Date(`${event.date}T${event.start || event.soundcheck || '21:00'}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function soundcheckAt(event) {
  if (!event?.date || !event?.soundcheck) return null;
  const d = new Date(`${event.date}T${event.soundcheck}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatEventDate(event) {
  if (!event?.date) return '';
  const d = new Date(`${event.date}T12:00`);
  if (Number.isNaN(d.getTime())) return event.date;
  const s = d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// "3g 14h", "5h 20m", "12m"
export function formatCountdown(ms) {
  if (ms <= 0) return 'ora';
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return `${d}g ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

// Expected end of the show. While live, it's now + what is still to play;
// before the show, the event start + the whole set.
export function expectedEnd(setlist, items, now = Date.now()) {
  const startedAt = setlist?.live?.startedAt?.toMillis?.();
  if (startedAt) {
    const remaining = totalDuration(items.filter((it) => !it.completed));
    return new Date(now + remaining * 1000);
  }
  const start = eventStart(setlist?.event);
  return start ? new Date(start.getTime() + totalDuration(items) * 1000) : null;
}

// Genre breakdown weighted by duration (falls back to song count).
export function genreBreakdown(items) {
  const songs = items.filter((it) => !isSeparator(it) && (it.genre || '').trim());
  const byDuration = songs.some((it) => it.duration);
  const totals = new Map();
  songs.forEach((it) => {
    const g = it.genre.trim();
    const key = g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
    totals.set(key, (totals.get(key) || 0) + (byDuration ? Number(it.duration) || 0 : 1));
  });
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  if (!sum) return [];
  return [...totals.entries()]
    .map(([genre, v]) => ({ genre, pct: Math.round((v / sum) * 100) }))
    .sort((a, b) => b.pct - a.pct);
}

// Fields copied when duplicating a setlist or saving a version: the content,
// not the live state (completion) nor timestamps.
export function itemPayload(it) {
  // eslint-disable-next-line no-unused-vars
  const { id, createdAt, updatedAt, completed, completedAt, completedBy, ...rest } = it;
  return rest;
}

export const LAST_SETLIST_KEY = 'livetools:lastSetlist';

export function rememberLastSetlist(id) {
  try {
    localStorage.setItem(LAST_SETLIST_KEY, id);
  } catch {
    // storage unavailable
  }
}

export function lastSetlistId() {
  try {
    return localStorage.getItem(LAST_SETLIST_KEY);
  } catch {
    return null;
  }
}

// ---------- Song editor ----------
// Shared by the web song modal and the desktop setlist page, so both save the
// same fields in the same shape.

// Editable copy of the built-in fields (numbers as strings while typing).
export function itemDraft(item) {
  return {
    title: item.title || '',
    artist: item.artist || '',
    playback: item.playback || '',
    key: item.key || '',
    bpm: item.bpm ? String(item.bpm) : '',
    timeSig: item.timeSig || '',
    duration: item.duration ? formatDuration(item.duration) : '',
    genre: item.genre || '',
    countInBars: item.countInBars ? String(item.countInBars) : '',
    clickMode: item.clickMode || '',
    drumNotes: item.drumNotes || '',
    chart: item.chart || '',
    lyrics: item.lyrics || '',
    chartUrl: item.chartUrl || '',
    midi: (item.midi || []).map((p) => ({ ...p })),
    sections: (item.sections || []).map((s) => ({ ...s })),
    values: { ...(item.values || {}) },
  };
}

export function itemFromDraft(d, item) {
  const num = (v) => (String(v).trim() === '' ? null : Number(v));
  return {
    title: d.title.trim() || item.title,
    artist: d.artist.trim() || null,
    playback: d.playback || null,
    key: d.key.trim() || null,
    bpm: Number(d.bpm) || null,
    timeSig: d.timeSig || null,
    duration: parseDuration(d.duration),
    genre: d.genre.trim() || null,
    countInBars: Number(d.countInBars) || null,
    clickMode: d.clickMode || null,
    drumNotes: d.drumNotes.trim() || null,
    chart: d.chart.trim() ? d.chart : null,
    lyrics: d.lyrics.trim() ? d.lyrics : null,
    chartUrl: d.chartUrl.trim() || null,
    midi: d.midi
      .filter((p) => p.label || p.program)
      .map((p) => ({
        label: (p.label || '').trim(),
        name: (p.name || '').trim(),
        channel: num(p.channel) ?? 1,
        program: num(p.program),
        bankMsb: num(p.bankMsb),
        bankLsb: num(p.bankLsb),
      })),
    sections: d.sections
      .filter((s) => s.bars && (s.bpm || s.timeSig))
      .map((s) => ({ label: (s.label || '').trim(), bars: Number(s.bars) || 1, bpm: Number(s.bpm) || null, timeSig: s.timeSig || null })),
    values: d.values,
  };
}

// Compare what would be saved with what is stored.
export function draftUnchanged(d, item) {
  const next = itemFromDraft(d, item);
  const stored = itemFromDraft(itemDraft(item), item);
  return JSON.stringify(next) === JSON.stringify(stored);
}
