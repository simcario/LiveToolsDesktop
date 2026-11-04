// Printed chord chart of a song (or of a whole setlist): title, artist, key,
// tempo and time on top, the roadmap of the sections (V1 V2 C1 B²…), then the
// sections in cards on two columns, chords on their syllables. Built from the
// same parser as the apps (music.js), as a standalone HTML page printed from
// a hidden frame, so the app's styles and theme never reach the paper.
// Shared by the web app and the desktop app (desktop/src/shared/chartSheet.js,
// see sync-shared).

import { chartRoadmap, isChord, parseChart, prefersFlat, sectionType, transposeKey } from './music';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const accidental = (s) => s.replace(/#/g, '♯').replace(/b/g, '♭');
/** 'Bb' → 'B♭', 'F#m' → 'F♯m' (the note letter is never touched). */
const noteText = (s) => (s ? s[0] + accidental(s.slice(1)) : '');

/** "Emaj7/G#" → E<sup>maj7</sup>/G♯; minor "m" stays on the line, the rest goes up. */
export function chordHtml(chord) {
  const m = /^([A-G])([#b]?)(.*?)(?:\/([A-G][#b]?))?$/.exec(chord || '');
  if (!m) return esc(chord);
  const [, root, acc, quality, bass] = m;
  const minor = /^m(?!aj)/.test(quality) ? 'm' : '';
  const ext = quality.slice(minor.length);
  return `${root}${accidental(acc)}${minor}${ext ? `<sup>${esc(ext)}</sup>` : ''}${bass ? `/${noteText(bass)}` : ''}`;
}

const colorOf = (kind) => sectionType(kind)?.color || '#5c5c5c';

function badgeHtml(s) {
  const size = s.badge.length > 2 ? ' is-long' : '';
  return `<span class="badge${size}" style="--c:${colorOf(s.kind)}" title="${esc(s.label)}">${esc(s.badge)}${
    s.repeat > 1 ? `<sup>${s.repeat}</sup>` : ''
  }</span>`;
}

function lineHtml(l) {
  if (l.type === 'comment') return `<div class="${l.expression ? 'expr-line' : 'comment'}">${esc(l.text)}</div>`;
  if (l.type === 'chords') {
    if (l.plain) return `<pre class="tab">${esc(l.text)}</pre>`;
    const tokens = l.text.split(/\s+/).filter(Boolean);
    return `<div class="line chords-only">${tokens.map((t) => `<b class="ch">${isChord(t) ? chordHtml(t) : esc(t)}</b>`).join('')}</div>`;
  }
  const withChords = l.segments.some((s) => s.chord);
  return `<div class="line${withChords ? '' : ' plain'}">${l.segments
    .map(
      (s) =>
        `<span class="seg">${withChords ? `<b class="ch">${s.chord ? chordHtml(s.chord) : '&nbsp;'}</b>` : ''}<span class="ly">${
          esc(s.text) || '&nbsp;'
        }</span></span>`,
    )
    .join('')}</div>`;
}

/** Sections to print: their own lines, without repeats and blank lines at the edges. */
function sectionsOf(lines) {
  const out = [];
  let cur = null;
  lines.forEach((l) => {
    if (l.type === 'section') {
      cur = l.ref ? null : { head: l, lines: [] };
      if (cur) out.push(cur);
      return;
    }
    if (!cur) {
      if (l.type === 'empty') return;
      cur = { head: null, lines: [] };
      out.push(cur);
    }
    // Without tags, each paragraph is a card of its own (one card for the
    // whole song would not fit a column and leave pages empty).
    if (!cur.head && l.type === 'empty') {
      cur = null;
      return;
    }
    cur.lines.push(l);
  });
  out.forEach((s) => {
    while (s.lines[0]?.type === 'empty') s.lines.shift();
    while (s.lines.at(-1)?.type === 'empty') s.lines.pop();
    // Several blank lines inside are one gap.
    s.lines = s.lines.filter((l, i) => l.type !== 'empty' || s.lines[i - 1]?.type !== 'empty');
  });
  return out.filter((s) => s.lines.length || s.head);
}

// Longer than this many lines, a card may be split between columns and pages.
const LONG = 16;

function sectionHtml({ head, lines }) {
  const body = lines.map((l) => (l.type === 'empty' ? '<div class="gap"></div>' : lineHtml(l))).join('');
  const wrap = `sec-wrap${lines.length > LONG ? ' is-long' : ''}`;
  if (!head) return `<div class="${wrap}"><section class="sec no-head">${body}</section></div>`;
  return `<div class="${wrap}"><section class="sec" style="--c:${colorOf(head.kind)}">
  <header class="sec-head">${badgeHtml({ ...head, repeat: 1 })}<span class="sec-name">${esc(head.label)}${
    head.repeat > 1 ? ` <span class="rep">×${head.repeat}</span>` : ''
  }</span></header>
  ${head.expression ? `<div class="expr">${esc(head.expression)}</div>` : ''}
  ${body}
</section></div>`;
}

/**
 * HTML of one song: { title, artist, key, bpm, timeSig, chart } plus the
 * semitones to transpose by (the key shown follows).
 */
function songHtml(song, semitones = 0) {
  const key = transposeKey(song.key || '', semitones) || '';
  const { meta, lines } = parseChart(song.chart || '', semitones, prefersFlat(key));
  const roadmap = chartRoadmap(lines);
  const shownKey = key || (meta.key ? transposeKey(meta.key, semitones) : '');
  const facts = [
    ['Tonalità', shownKey && noteText(shownKey)],
    ['Tempo', song.tempoBpm || song.bpm || meta.tempo],
    ['Metro', song.timeSig || meta.time],
    ['Capo', meta.capo],
  ].filter(([, v]) => v);
  const credits = [meta.copyright, meta.ccli && `CCLI ${meta.ccli}`].filter(Boolean).join(' · ');
  return `<article class="song">
  <header class="top">
    <div>
      <h1>${esc(song.title || meta.title || 'Senza titolo')}</h1>
      <div class="artist">${esc(song.artist || meta.artist || meta.subtitle || '')}</div>
    </div>
    <div class="facts">${facts.map(([k, v]) => `<span>${k}: <b>${esc(v)}</b></span>`).join('')}</div>
  </header>
  ${roadmap.length > 1 ? `<nav class="map">${roadmap.map(badgeHtml).join('')}</nav>` : ''}
  <div class="cols">${sectionsOf(lines).map(sectionHtml).join('\n')}</div>
  <footer class="foot">
    <span class="credits">${esc(credits)}</span>
    <span class="brand">Stampato con <img src="${LOGO}" alt="LiveTools"></span>
  </footer>
</article>`;
}

const CSS = `
@page {
  size: A4;
  margin: 14mm 13mm 15mm;
  /* Taking the top boxes too keeps the browser's own header (date, title) off the page. */
  @top-left { content: " "; }
  @top-center { content: " "; }
  @top-right { content: " "; }
  @bottom-left { content: "LiveTools"; font: 600 7.5pt 'Segoe UI', Arial, sans-serif; color: #9a9a9a; }
  @bottom-right { content: "Pagina " counter(page) " di " counter(pages); font: 7.5pt 'Segoe UI', Arial, sans-serif; color: #9a9a9a; }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; }
body {
  font-family: 'Open Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: #1d1d1f;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.song + .song { break-before: page; }
.top { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
h1 { margin: 0; font-size: 21pt; font-weight: 700; letter-spacing: -0.01em; line-height: 1.1; }
.artist { margin-top: 3px; color: #8d8d8d; font-size: 8.5pt; }
.facts { display: flex; gap: 12px; font-size: 8pt; color: #9a9a9a; white-space: nowrap; }
.facts b { color: #555; font-weight: 600; }
.map { display: flex; flex-wrap: wrap; gap: 6px 7px; margin: 13px 0 6px; }
.badge {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  width: 23px; height: 23px; flex: none;
  border: 1.7px solid var(--c); border-radius: 50%;
  font-size: 7.5pt; font-weight: 700; color: #222; background: #fff;
  text-transform: none; letter-spacing: 0;
}
.badge.is-long { font-size: 6.3pt; letter-spacing: -0.02em; }
.badge sup { position: absolute; top: -5px; right: -5px; font-size: 6.5pt; font-weight: 700; color: #222; }
.cols { column-count: 2; column-gap: 26px; margin-top: 4px; }
/* Padding, not margin: margins are cut at the top of a column. */
.sec-wrap { break-inside: avoid; padding: 13px 0 2px; }
.sec-wrap.is-long { break-inside: auto; }
.sec {
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  position: relative;
  margin: 0;
  padding: 17px 13px 11px;
  border: 1.1px solid #cfcfcf;
  border-radius: 9px;
}
.sec.no-head { padding-top: 11px; }
.sec-head {
  position: absolute; top: -12px; left: 9px;
  display: flex; align-items: center; gap: 6px;
  padding: 0 6px; background: #fff;
  font-size: 10.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em;
}
.sec-head .badge { width: 21px; height: 21px; }
.rep { color: #8d8d8d; font-weight: 700; text-transform: none; }
.expr { margin: -6px 0 6px; text-align: right; color: #8d8d8d; font-size: 8.8pt; }
.expr-line { margin: 2px 0 4px; text-align: right; color: #8d8d8d; font-size: 8.8pt; font-style: italic; }
.comment { margin: 2px 0 4px; color: #777; font-size: 8.8pt; font-style: italic; }
.line { display: flex; flex-wrap: wrap; align-items: flex-end; margin: 0 0 5px; }
.seg { display: inline-flex; flex-direction: column; white-space: pre; }
.ch { min-height: 1.2em; padding-right: 5px; font-size: 9.6pt; font-weight: 700; color: #111; line-height: 1.2; }
.ch sup { font-size: 0.68em; vertical-align: 0.55em; line-height: 0; }
.ly { font-size: 10pt; line-height: 1.25; color: #2a2a2a; }
.chords-only { gap: 0 15px; }
.chords-only .ch { padding: 0; }
.gap { height: 7px; }
.tab { margin: 0 0 4px; font: 8.5pt Consolas, 'Courier New', monospace; white-space: pre-wrap; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; break-inside: avoid; }
.credits { color: #9a9a9a; font-size: 7.5pt; }
.brand { display: inline-flex; align-items: center; gap: 6px; flex: none; color: #9a9a9a; font-size: 7pt; }
.brand img { display: block; height: 6.5mm; border-radius: 1.6mm; }
@media screen {
  body { padding: 24px; background: #e9e9ec; }
  .song { max-width: 210mm; margin: 0 auto 24px; padding: 14mm 13mm; background: #fff; box-shadow: 0 2px 14px rgba(0, 0, 0, 0.18); }
}
`;

/**
 * The whole page: songs = [{ title, artist, key, bpm, timeSig, chart, semitones? }];
 * without semitones a setlist item is transposed by its item.transpose.
 * columns: 2 (default) or 1.
 */
export function chartSheetHtml(songs, { title, columns = 2 } = {}) {
  const list = (Array.isArray(songs) ? songs : [songs]).filter((s) => (s?.chart || '').trim());
  // Setlist items print in the key and tempo they are played in (item.transpose, item.tempoBpm).
  const body = list.map((s) => songHtml(s, s.semitones ?? (Math.round(Number(s.transpose)) || 0))).join('\n');
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>${esc(title || list[0]?.title || 'Accordi')}</title>
<style>${CSS}${columns === 1 ? '.cols { column-count: 1; }' : ''}</style></head>
<body>${body}</body></html>`;
}

/** Prints the page from a hidden frame (the system dialog also saves it as PDF). */
export function printChartSheet(html) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  const doc = win.document;
  doc.open();
  doc.write(html);
  doc.close();
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    setTimeout(() => frame.remove(), 500);
  };
  win.addEventListener('afterprint', remove);
  // Fonts and layout first, then the dialog.
  const go = () => {
    win.focus();
    win.print();
    setTimeout(remove, 120000);
  };
  const images = Promise.all([...doc.images].map((img) => img.decode?.().catch(() => {})));
  Promise.all([doc.fonts?.ready, images]).then(() => setTimeout(go, 50));
}

/** Prints the chords of one song, or of several (one per page). */
export function printChords(songs, options) {
  const html = chartSheetHtml(songs, options);
  printChartSheet(html);
}

// Logo of the app in a small dark label (its white parts would vanish on paper),
// inline so the hidden print frame never waits for a file. 327x84 JPEG.
const LOGO = "data:image/jpeg;base64,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";
