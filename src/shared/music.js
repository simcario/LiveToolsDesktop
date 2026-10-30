// Keys, chord transposition and a small ChordPro parser for the live viewer.

const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const INDEX = {
  C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, F: 5, 'E#': 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11,
};

// Keys offered in the song editor (major and minor).
export const KEYS = [
  ...SHARPS.map((n, i) => (FLATS[i] !== n && [1, 3, 8, 10].includes(i) ? FLATS[i] : n)),
  ...SHARPS.map((n, i) => `${[3, 10].includes(i) ? FLATS[i] : n}m`),
];

const CHORD_RE = /^[A-G][#b]?(?:maj|min|m|M|dim|aug|sus|add|ø|°|\+|-|[0-9]|[#b]|\(|\)|\^|Δ|\/[A-G][#b]?)*$/;

export function isChord(token) {
  return CHORD_RE.test(token) && !/^N\.?C\.?$/i.test(token);
}

function shiftNote(note, semitones, preferFlat) {
  const i = INDEX[note];
  if (i === undefined) return note;
  const n = (((i + semitones) % 12) + 12) % 12;
  return (preferFlat ? FLATS : SHARPS)[n];
}

// Flats read better in flat keys (F, Bb, Eb, … and their relative minors).
export function prefersFlat(key) {
  const m = /^([A-G][#b]?)(m?)/.exec(key || '');
  if (!m) return false;
  if (m[1].includes('b')) return true;
  if (m[1].includes('#')) return false;
  return m[2] ? ['D', 'G', 'C', 'F'].includes(m[1]) : m[1] === 'F';
}

export function transposeChord(chord, semitones, preferFlat = false) {
  if (!semitones || !isChord(chord)) return chord;
  return chord.replace(/([A-G])([#b]?)/g, (_, root, acc) => shiftNote(root + acc, semitones, preferFlat));
}

// Uses the usual spelling of the resulting key (Bb, not A#; F#m, not Gbm).
export function transposeKey(key, semitones) {
  if (!key || !semitones) return key || '';
  const m = /^([A-G][#b]?)(m?)(.*)$/.exec(key.trim());
  if (!m || INDEX[m[1]] === undefined) return key;
  const n = (((INDEX[m[1]] + semitones) % 12) + 12) % 12;
  const name = KEYS[m[2] ? 12 + n : n];
  return `${name}${m[3]}`;
}

// "G" → "G Maj", "Em" → "E min" for the big tiles.
export function keyLabel(key) {
  const m = /^([A-G][#b]?)(m?)$/.exec((key || '').trim());
  if (!m) return key || '';
  return `${m[1]} ${m[2] ? 'min' : 'Maj'}`;
}

const SECTION_DIRECTIVES = {
  start_of_chorus: 'Ritornello',
  soc: 'Ritornello',
  start_of_verse: 'Strofa',
  sov: 'Strofa',
  start_of_bridge: 'Bridge',
  sob: 'Bridge',
  start_of_tab: 'Tab',
  sot: 'Tab',
};
const END_DIRECTIVES = new Set(['end_of_chorus', 'eoc', 'end_of_verse', 'eov', 'end_of_bridge', 'eob', 'end_of_tab', 'eot']);
const COMMENT_DIRECTIVES = new Set(['comment', 'c', 'ci', 'comment_italic', 'cb', 'comment_box', 'highlight']);

// A line made only of chords (the "chords over lyrics" text format).
function isChordLine(line) {
  const tokens = line.trim().split(/\s+/).filter((t) => t && !/^[|\-–/.x0-9()]+$/.test(t));
  return tokens.length > 0 && tokens.every(isChord);
}

/**
 * Parses ChordPro (inline [C] chords and {directives}) and plain
 * "chords over lyrics" text into renderable lines:
 *   { type: 'section', label, kind }   section start (chorus is highlighted)
 *   { type: 'comment', text }
 *   { type: 'chords', text }           chords-only line (monospace)
 *   { type: 'lyrics', segments: [{ chord, text }] }
 *   { type: 'empty' }
 * Bracketed text that isn't a chord (e.g. "[Intro]") becomes a section label.
 */
export function parseChart(source, semitones = 0, preferFlat = false) {
  const meta = {};
  const lines = [];
  let inSection = null;
  (source || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    const directive = /^\s*\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/i.exec(line);
    if (directive) {
      const name = directive[1].toLowerCase();
      const value = directive[2] || '';
      if (SECTION_DIRECTIVES[name]) {
        inSection = name.includes('chorus') || name === 'soc' ? 'chorus' : name.includes('tab') || name === 'sot' ? 'tab' : 'verse';
        lines.push({ type: 'section', label: value || SECTION_DIRECTIVES[name], kind: inSection });
      } else if (END_DIRECTIVES.has(name)) {
        inSection = null;
      } else if (COMMENT_DIRECTIVES.has(name)) {
        lines.push({ type: 'comment', text: value });
      } else if (['title', 't', 'subtitle', 'st', 'artist', 'key', 'tempo', 'time', 'capo'].includes(name)) {
        meta[name === 't' ? 'title' : name === 'st' ? 'subtitle' : name] = value;
      }
      return;
    }
    if (!line.trim()) {
      lines.push({ type: 'empty' });
      return;
    }
    if (inSection === 'tab') {
      lines.push({ type: 'chords', text: line, plain: true });
      return;
    }
    if (!line.includes('[') && isChordLine(line)) {
      const text = line.replace(/\S+/g, (tok) => transposeChord(tok, semitones, preferFlat));
      lines.push({ type: 'chords', text, chorus: inSection === 'chorus' });
      return;
    }
    const segments = [];
    const re = /\[([^\]]*)\]/g;
    let last = 0;
    let chord = null;
    let m;
    let label = null;
    while ((m = re.exec(line))) {
      const inner = m[1].trim();
      if (!isChord(inner)) {
        // "[Intro]" at the start of a line: section label, keep the rest.
        if (m.index === 0 && segments.length === 0) {
          label = inner;
          last = m.index + m[0].length;
          continue;
        }
        continue;
      }
      if (m.index > last || chord !== null) segments.push({ chord, text: line.slice(last, m.index) });
      chord = transposeChord(inner, semitones, preferFlat);
      last = m.index + m[0].length;
    }
    segments.push({ chord, text: line.slice(last) });
    if (label) lines.push({ type: 'section', label, kind: /rit|chor/i.test(label) ? 'chorus' : 'verse' });
    const rest = segments.filter((s) => s.chord || s.text.trim());
    if (rest.length === 0) return;
    // "[Intro] G - Em - C": a chords-only line written as text.
    if (rest.every((s) => !s.chord) && isChordLine(rest.map((s) => s.text).join(' '))) {
      const text = rest.map((s) => s.text).join('').replace(/\S+/g, (tok) => transposeChord(tok, semitones, preferFlat));
      lines.push({ type: 'chords', text: text.trim(), chorus: inSection === 'chorus' });
      return;
    }
    lines.push({ type: 'lyrics', segments: rest, chorus: inSection === 'chorus' });
  });
  return { meta, lines };
}

// ---------- Lyrics for the prompter (gobbo of LiveTools Desktop) ----------
// A song's lyrics come from its `lyrics` field (plain text: blocks separated
// by a blank line, optional "[Label]" line on top of a block) or, when that
// is empty, from the chart without its chords.

const cleanLine = (t) => t.replace(/\s+/g, ' ').trim();

/** Lyrics of a chart (ChordPro or chords over lyrics) without chords, in blocks. */
export function chartLyricBlocks(chart) {
  const { lines } = parseChart(chart);
  const blocks = [];
  let cur = null;
  const open = (label) => {
    cur = { label: label || '', lines: [] };
    blocks.push(cur);
  };
  lines.forEach((l) => {
    if (l.type === 'section') open(l.label);
    else if (l.type === 'comment' && !cur?.lines.length) open(l.text);
    else if (l.type === 'empty') {
      if (cur?.lines.length) cur = null;
    } else if (l.type === 'lyrics') {
      const text = cleanLine(l.segments.map((s) => s.text).join(''));
      if (!text) return;
      if (!cur) open(l.chorus ? 'Ritornello' : '');
      cur.lines.push(text);
    }
  });
  return blocks.filter((b) => b.lines.length);
}

/** Blocks of plain lyrics: a blank line closes a block, "[Label]" names the next one. */
export function plainLyricBlocks(text) {
  const blocks = [];
  let cur = null;
  (text || '').split(/\r?\n/).forEach((raw) => {
    const line = cleanLine(raw);
    const label = /^\[(.+)\]$/.exec(line);
    if (label) {
      cur = { label: label[1].trim(), lines: [] };
      blocks.push(cur);
    } else if (!line) {
      if (cur?.lines.length) cur = null;
    } else {
      if (!cur) {
        cur = { label: '', lines: [] };
        blocks.push(cur);
      }
      cur.lines.push(line);
    }
  });
  return blocks.filter((b) => b.lines.length);
}

export const hasOwnLyrics = (item) => !!(item?.lyrics || '').trim();

/** Lyric blocks of a song: its own lyrics, otherwise the ones in the chart. */
export function songLyricBlocks(item) {
  if (hasOwnLyrics(item)) return plainLyricBlocks(item.lyrics);
  return item?.chart ? chartLyricBlocks(item.chart) : [];
}

export function lyricBlocksText(blocks) {
  return blocks.map((b) => (b.label ? `[${b.label}]\n` : '') + b.lines.join('\n')).join('\n\n');
}
