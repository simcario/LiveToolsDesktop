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

// ---------- Section and expression tags ----------
// A chart is split into sections by a header line: "[Strofa 1]", "[Chorus]",
// "Bridge x2", "[V2 | Softly]" or the ChordPro {start_of_verse: Strofa 1}.
// Each section has a type and a badge (V1, C1, B, Vp…) used by the roadmap
// of the printed chart. Writing again the header of a section already
// written, without lines (or {chorus}), repeats it in the roadmap.
// "x2" at the end of a header repeats it; "| text" or {expr: text} is the
// expression of the section (Softly, Build…), shown on its header.

// color: of the badge, on paper and in the apps.
export const SECTION_TYPES = [
  { type: 'intro', abbr: 'I', label: 'Intro', color: '#2f6fb3', names: ['intro', 'introduzione'] },
  { type: 'verse', abbr: 'V', label: 'Strofa', color: '#5a46b8', names: ['strofa', 'verse', 'verso', 'v', 's'] },
  { type: 'prechorus', abbr: 'Pc', label: 'Pre-ritornello', color: '#c0651c', names: ['pre-chorus', 'prechorus', 'pre chorus', 'pre-ritornello', 'pre ritornello', 'pre-rit', 'prerit', 'pc'] },
  { type: 'chorus', abbr: 'C', label: 'Ritornello', color: '#a3302a', names: ['ritornello', 'rit', 'chorus', 'coro', 'refrain', 'c', 'r'] },
  { type: 'postchorus', abbr: 'Po', label: 'Post-ritornello', color: '#b8434e', names: ['post-chorus', 'postchorus', 'post chorus', 'post-ritornello', 'post ritornello', 'po'] },
  { type: 'bridge', abbr: 'B', label: 'Bridge', color: '#8c2f57', names: ['bridge', 'ponte', 'b'] },
  { type: 'interlude', abbr: 'It', label: 'Interludio', color: '#2a8a8f', names: ['interlude', 'interludio', 'it'] },
  { type: 'instrumental', abbr: 'Is', label: 'Strumentale', color: '#2a8a8f', names: ['instrumental', 'strumentale', 'solo', 'is'] },
  { type: 'vamp', abbr: 'Vp', label: 'Vamp', color: '#8a5a2b', names: ['vamp', 'vp'] },
  { type: 'turnaround', abbr: 'Ta', label: 'Turnaround', color: '#2f8a3e', names: ['turnaround', 'turn', 'ta'] },
  { type: 'tag', abbr: 'Tg', label: 'Tag', color: '#6f7d1e', names: ['tag', 'tg'] },
  { type: 'breakdown', abbr: 'Bd', label: 'Breakdown', color: '#5c5c5c', names: ['breakdown', 'break', 'bd'] },
  { type: 'ending', abbr: 'E', label: 'Finale', color: '#1f7a7a', names: ['finale', 'ending', 'end', 'e'] },
  { type: 'outro', abbr: 'O', label: 'Outro', color: '#1f7a7a', names: ['outro', 'coda', 'o'] },
];
const TYPE_OF_NAME = new Map(SECTION_TYPES.flatMap((t) => t.names.map((n) => [n, t])));
export const sectionType = (type) => SECTION_TYPES.find((t) => t.type === type) || null;

/** Expressions offered by the editors (any text can be written). */
export const EXPRESSION_TAGS = [
  'Soft',
  'Dolce',
  'Piano e voce',
  'Build',
  'Crescendo',
  'Forte',
  'Full band',
  'Tutti',
  'Solo voce',
  'Drums only',
  'Halftime',
  'Stop',
  'Rallentando',
  'A cappella',
  'Fade out',
];

/** What each offered expression means, for the legend of the editors. */
export const EXPRESSION_HINTS = {
  Soft: 'Dinamica bassa, suonare piano',
  Dolce: 'Delicato ed espressivo',
  'Piano e voce': 'Suonano solo pianoforte e voce',
  Build: 'La band cresce poco a poco',
  Crescendo: 'Aumentare gradualmente il volume',
  Forte: 'Dinamica alta',
  'Full band': 'Tutta la band, suono pieno',
  Tutti: 'Entrano tutti gli strumenti',
  'Solo voce': 'Canta la voce senza strumenti',
  'Drums only': 'Suona solo la batteria',
  Halftime: 'Batteria a metà tempo',
  Stop: 'Tutti fermi (break)',
  Rallentando: 'Rallentare gradualmente',
  'A cappella': 'Solo voci, senza strumenti',
  'Fade out': 'Sfumare fino al silenzio',
};

/**
 * A section header ("Strofa 2", "Ritornello x2", "V1 | Softly", "Rit.:"),
 * or null when the text isn't one. With `loose` any text is a header (of
 * unknown type): used for "[Label]" and ChordPro directives.
 */
export function sectionOf(text, loose = false) {
  let rest = (text || '').trim().replace(/:$/, '').trim();
  // "C2" alone is a chord, not "Chorus 2".
  if (!loose && isChord(rest.replace(/\s+/g, ''))) return null;
  let expression = '';
  const bar = rest.indexOf('|');
  if (bar >= 0) {
    expression = rest.slice(bar + 1).trim();
    rest = rest.slice(0, bar).trim();
  }
  let repeat = 1;
  const rep = /\s*[([]?\s*[x×]\s*(\d+)\s*[)\]]?$/i.exec(rest);
  if (rep && rep.index > 0) {
    repeat = Math.max(1, Number(rep[1]) || 1);
    rest = rest.slice(0, rep.index).trim();
  }
  let number = null;
  const num = /^(.*?[^\d\s])\s*(\d+)$/.exec(rest);
  const base = (num ? num[1] : rest).replace(/\.$/, '').trim();
  if (num) number = Number(num[2]);
  const t = TYPE_OF_NAME.get(base.toLowerCase());
  // A single letter is a header only with its number ("V1"), or in brackets.
  if (!t && !loose) return null;
  if (t && !loose && base.length <= 2 && number == null && !rep) return null;
  return { type: t?.type || 'other', number, repeat, expression, name: rest };
}

const SECTION_DIRECTIVES = {
  soc: 'chorus',
  sov: 'verse',
  sob: 'bridge',
  sot: 'tab',
  sog: 'other',
};
const START_TYPES = {
  chorus: 'chorus',
  verse: 'verse',
  bridge: 'bridge',
  tab: 'tab',
  grid: 'other',
  intro: 'intro',
  prechorus: 'prechorus',
  pre_chorus: 'prechorus',
  postchorus: 'postchorus',
  post_chorus: 'postchorus',
  interlude: 'interlude',
  instrumental: 'instrumental',
  solo: 'instrumental',
  vamp: 'vamp',
  turnaround: 'turnaround',
  tag: 'tag',
  breakdown: 'breakdown',
  ending: 'ending',
  outro: 'outro',
};
const COMMENT_DIRECTIVES = new Set(['comment', 'c', 'ci', 'comment_italic', 'cb', 'comment_box', 'highlight']);
const EXPRESSION_DIRECTIVES = new Set(['expr', 'expression', 'dyn', 'dynamics']);

// A line made only of chords (the "chords over lyrics" text format).
function isChordLine(line) {
  const tokens = line.trim().split(/\s+/).filter((t) => t && !/^[|\-–/.x0-9()]+$/.test(t));
  return tokens.length > 0 && tokens.every(isChord);
}

/** Default name of a section: "Strofa 2", "Ritornello". */
const defaultLabel = (s) => `${sectionType(s.type)?.label || 'Sezione'}${s.number ? ` ${s.number}` : ''}`;

/**
 * Parses ChordPro (inline [C] chords and {directives}) and plain
 * "chords over lyrics" text into renderable lines:
 *   { type: 'section', label, kind, badge, number, repeat, expression, ref }
 *       section start (kind: chorus, verse, bridge, intro… see SECTION_TYPES);
 *       ref = repeat of a section written before, with no lines of its own
 *   { type: 'comment', text, expression }
 *   { type: 'chords', text }           chords-only line (monospace)
 *   { type: 'lyrics', segments: [{ chord, text }] }
 *   { type: 'empty' }
 * A chords line followed by a lyrics line (chords over lyrics) becomes one
 * lyrics line with the chords on their syllables.
 * Bracketed text that isn't a chord (e.g. "[Intro]") becomes a section label.
 */
export function parseChart(source, semitones = 0, preferFlat = false) {
  const meta = {};
  const lines = [];
  let inSection = null; // kind of the current section (chorus lines are highlighted)
  let tab = false; // {start_of_tab}: lines as written
  let pending = null; // chords line that the next lyrics line may take
  const tr = (c) => transposeChord(c, semitones, preferFlat);
  const pushSection = (head, ref = false) => {
    inSection = head.type;
    lines.push({
      type: 'section',
      kind: head.type,
      label: head.name || defaultLabel(head),
      number: head.number,
      repeat: head.repeat || 1,
      expression: head.expression || '',
      ref,
    });
  };
  const lastSectionOpen = () => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].type === 'section') return lines[i];
      if (lines[i].type !== 'empty') return null;
    }
    return null;
  };

  (source || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    const chordsBefore = pending;
    pending = null;
    const directive = /^\s*\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/i.exec(line);
    if (directive) {
      const name = directive[1].toLowerCase();
      const value = directive[2] || '';
      const start = SECTION_DIRECTIVES[name] || START_TYPES[/^start_of_(\w+)$/.exec(name)?.[1]] || (/^start_of_/.test(name) && 'other');
      if (start) {
        tab = start === 'tab';
        const head = (value && sectionOf(value, true)) || { type: start, number: null, repeat: 1, expression: '', name: '' };
        // {sov: Coda}: the label names the section, the directive its type.
        if (head.type === 'other' && start !== 'tab') head.type = start;
        if (!head.name) head.name = start === 'tab' ? 'Tab' : '';
        pushSection(head);
      } else if (/^(end_of_\w+|eo[cvbtg])$/.test(name)) {
        inSection = null;
        tab = false;
      } else if (name === 'chorus') {
        // ChordPro: repeat the chorus here.
        pushSection({ ...(sectionOf(value, true) || {}), type: 'chorus', name: value || '' }, true);
        inSection = null;
      } else if (EXPRESSION_DIRECTIVES.has(name)) {
        const open = lastSectionOpen();
        if (open && !open.expression) open.expression = value;
        else lines.push({ type: 'comment', text: value, expression: true });
      } else if (COMMENT_DIRECTIVES.has(name)) {
        lines.push({ type: 'comment', text: value });
      } else if (['title', 't', 'subtitle', 'st', 'artist', 'key', 'tempo', 'time', 'capo', 'copyright', 'ccli'].includes(name)) {
        meta[name === 't' ? 'title' : name === 'st' ? 'subtitle' : name] = value;
      }
      return;
    }
    if (!line.trim()) {
      lines.push({ type: 'empty' });
      return;
    }
    if (tab) {
      lines.push({ type: 'chords', text: line, plain: true });
      return;
    }
    // "Strofa 2", "Rit. x2:" alone on a line.
    const header = !line.includes('[') && !line.includes('{') && sectionOf(line);
    if (header) {
      pushSection(header);
      return;
    }
    if (!line.includes('[') && isChordLine(line)) {
      const text = line.replace(/\S+/g, (tok) => tr(tok));
      lines.push({ type: 'chords', text, chorus: inSection === 'chorus' });
      pending = { index: lines.length - 1, raw: line };
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
      chord = tr(inner);
      last = m.index + m[0].length;
    }
    segments.push({ chord, text: line.slice(last) });
    if (label) pushSection(sectionOf(label) || sectionOf(label, true));
    const rest = segments.filter((s) => s.chord || s.text.trim());
    if (rest.length === 0) return;
    // "[Intro] G - Em - C": a chords-only line written as text.
    if (rest.every((s) => !s.chord) && isChordLine(rest.map((s) => s.text).join(' '))) {
      const text = rest.map((s) => s.text).join('').replace(/\S+/g, (tok) => tr(tok));
      lines.push({ type: 'chords', text: text.trim(), chorus: inSection === 'chorus' });
      return;
    }
    // Chords over lyrics: the chords line above gives the chords of this one.
    if (chordsBefore && !label && rest.every((s) => !s.chord)) {
      lines[chordsBefore.index] = { type: 'lyrics', segments: mergeChords(chordsBefore.raw, line, tr), chorus: inSection === 'chorus' };
      return;
    }
    lines.push({ type: 'lyrics', segments: rest, chorus: inSection === 'chorus' });
  });
  markSections(lines);
  return { meta, lines };
}

/** Lyrics segments from a chords line and the lyrics line under it, by column. */
function mergeChords(chordLine, lyric, tr) {
  const chords = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(chordLine))) if (isChord(m[0])) chords.push({ col: m.index, chord: tr(m[0]) });
  const segments = [];
  if (!chords.length || chords[0].col > 0) segments.push({ chord: null, text: lyric.slice(0, chords[0]?.col ?? lyric.length) });
  chords.forEach((c, i) => {
    const next = chords[i + 1]?.col;
    let text = lyric.slice(c.col, next ?? Math.max(lyric.length, c.col));
    // Past the end of the lyric the chords keep the distance they were written at.
    if (next != null && text.length < next - c.col) text = text.padEnd(next - c.col, ' ');
    segments.push({ chord: c.chord, text });
  });
  return segments.filter((s) => s.chord || s.text);
}

const sectionKey = (s) => (s.number != null ? `${s.kind}#${s.number}` : s.label.toLowerCase());

/**
 * Badges of the sections (V1, C, Vp…) and repeats: a header already used,
 * with no lines of its own, is a repeat (ref) of the first one.
 */
function markSections(lines) {
  const heads = [];
  lines.forEach((l, i) => {
    if (l.type !== 'section') return;
    let j = i + 1;
    while (j < lines.length && lines[j].type !== 'section' && ['empty', 'comment'].includes(lines[j].type)) j++;
    heads.push({ line: l, empty: j >= lines.length || lines[j].type === 'section' });
  });
  const seen = new Map();
  heads.forEach((h) => {
    const k = sectionKey(h.line);
    if (seen.has(k) && (h.empty || h.line.ref)) h.line.ref = true;
    else if (h.line.ref && h.line.kind === 'chorus' && !h.line.number) {
      // {chorus}: the last chorus written.
      const last = [...seen.values()].reverse().find((x) => x.kind === 'chorus');
      if (last) h.line.label = last.label;
      h.ref = last;
    } else {
      h.line.ref = false;
      if (!seen.has(k)) seen.set(k, h.line);
    }
  });
  // Numbers: when a type has more than one distinct section.
  const distinct = {};
  seen.forEach((l) => (distinct[l.kind] = (distinct[l.kind] || 0) + 1));
  const next = {};
  seen.forEach((l) => {
    const t = sectionType(l.kind);
    const abbr = t?.abbr || (l.label.match(/[A-Za-zÀ-ú]/)?.[0] || '?').toUpperCase();
    let n = l.number;
    if (n == null && distinct[l.kind] > 1) {
      next[l.kind] = (next[l.kind] || 0) + 1;
      n = next[l.kind];
    } else if (n != null) next[l.kind] = Math.max(next[l.kind] || 0, n);
    l.badge = `${abbr}${n ?? ''}`;
  });
  heads.forEach((h) => {
    if (h.line.badge) return;
    const first = h.ref || seen.get(sectionKey(h.line));
    h.line.badge = first?.badge || sectionType(h.line.kind)?.abbr || '?';
  });
}

/** The order of the sections, repeats included: [{ badge, kind, label, repeat }]. */
export function chartRoadmap(lines) {
  return lines.filter((l) => l.type === 'section').map((l) => ({ badge: l.badge, kind: l.kind, label: l.label, repeat: l.repeat }));
}

/**
 * Text and caret after putting `line` on a line of its own at `pos`: on the
 * current line when it is blank, otherwise after it.
 */
export function insertLine(text, pos, line) {
  const src = text || '';
  const at = Math.min(Math.max(0, pos ?? src.length), src.length);
  const start = src.lastIndexOf('\n', at - 1) + 1;
  let end = src.indexOf('\n', at);
  if (end < 0) end = src.length;
  if (!src.slice(start, end).trim()) {
    return { text: src.slice(0, start) + line + src.slice(end), caret: start + line.length };
  }
  return { text: `${src.slice(0, end)}\n${line}${src.slice(end)}`, caret: end + 1 + line.length };
}

/** Header of the next section of a type for the editors' tags: "[Strofa 3]". */
export function nextSectionHeader(chart, type) {
  const t = sectionType(type);
  const used = parseChart(chart)
    .lines.filter((l) => l.type === 'section' && l.kind === type && !l.ref)
    .map((l) => l.number || 1);
  const numbered = ['verse', 'chorus', 'prechorus', 'bridge'].includes(type) || used.length > 0;
  const n = used.length ? Math.max(...used) + 1 : 1;
  return `[${t.label}${numbered ? ` ${n}` : ''}]`;
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
