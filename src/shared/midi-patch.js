// MIDI patches of a song (item.midi), shared by web, desktop and mobile (desktop
// src/shared/midiPatch.js via sync-shared): the messages each patch sends when the
// song becomes the one on stage, and where each instrument goes on this device.
//
// patch: { label, name, channel 1-16, program 1-128?, bankMsb 0-127?, bankLsb 0-127?,
//          cc: [{ n 0-127, v 0-127 }]?, sysex: 'F0 … F7'? }

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const given = (v) => v !== '' && v != null;

// Control Change written as "7=100, 91=40" (also "7:100 91:40").
export function parseCc(text) {
  if (Array.isArray(text)) return text;
  const out = [];
  String(text || '')
    .split(/[,;\s]+/)
    .filter(Boolean)
    .forEach((pair) => {
      const m = /^(\d{1,3})[=:](\d{1,3})$/.exec(pair);
      if (m) out.push({ n: clamp(Number(m[1]), 0, 127), v: clamp(Number(m[2]), 0, 127) });
    });
  return out;
}

export const formatCc = (cc) => (Array.isArray(cc) ? cc.map((c) => `${c.n}=${c.v}`).join(', ') : cc || '');

// Text that does not read as Control Change pairs (shown as an error under the field).
export function ccError(text) {
  const bad = String(text || '')
    .split(/[,;\s]+/)
    .filter(Boolean)
    .find((pair) => !/^(\d{1,3})[=:](\d{1,3})$/.test(pair) || pair.split(/[=:]/).some((x) => Number(x) > 127));
  return bad ? `“${bad}” non è un Control Change (numero=valore, 0-127)` : null;
}

// SysEx in hex ("F0 43 10 4C 00 00 7E 00 F7"); several messages one after the other.
export function parseSysex(text) {
  const hex = String(text || '').replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (!hex || hex.length % 2) return [];
  const bytes = hex.match(/../g).map((b) => parseInt(b, 16));
  const msgs = [];
  let cur = null;
  bytes.forEach((b) => {
    if (b === 0xf0) cur = [b];
    else if (cur) {
      cur.push(b);
      if (b === 0xf7) {
        msgs.push(cur);
        cur = null;
      }
    }
  });
  return msgs;
}

export function sysexError(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const hex = t.replace(/0x/gi, '').replace(/[\s,]/g, '');
  if (/[^0-9a-f]/i.test(hex)) return 'Solo cifre esadecimali (es. F0 43 10 4C … F7)';
  if (hex.length % 2) return 'Manca una cifra: ogni byte ha due cifre';
  if (!parseSysex(t).length) return 'Ogni messaggio inizia con F0 e finisce con F7';
  const inner = parseSysex(t).some((m) => m.slice(1, -1).some((b) => b > 0x7f));
  return inner ? 'Tra F0 e F7 i byte vanno da 00 a 7F' : null;
}

/** The messages of a patch, in order: Bank Select, Program Change, Control Change, SysEx. */
export function patchMessages(patch) {
  const ch = clamp((Number(patch.channel) || 1) - 1, 0, 15);
  const msgs = [];
  if (given(patch.bankMsb)) msgs.push([0xb0 | ch, 0, clamp(Number(patch.bankMsb) || 0, 0, 127)]);
  if (given(patch.bankLsb)) msgs.push([0xb0 | ch, 32, clamp(Number(patch.bankLsb) || 0, 0, 127)]);
  if (given(patch.program)) msgs.push([0xc0 | ch, clamp((Number(patch.program) || 1) - 1, 0, 127)]);
  parseCc(patch.cc).forEach((c) => msgs.push([0xb0 | ch, c.n, c.v]));
  parseSysex(patch.sysex).forEach((m) => msgs.push(m));
  return msgs;
}

export const hasSysex = (patches = []) => patches.some((p) => parseSysex(p.sysex).length > 0);

export function describePatch(p) {
  const bank = [p.bankMsb, p.bankLsb].filter(given).join('/');
  const cc = parseCc(p.cc);
  const parts = [`Ch ${p.channel || 1}`, `PC ${given(p.program) ? p.program : '—'}`];
  if (bank) parts.push(`Bank ${bank}`);
  if (cc.length) parts.push(`CC ${formatCc(cc)}`);
  if (parseSysex(p.sysex).length) parts.push('SysEx');
  return parts.join(' · ');
}

// Name of the instrument of a patch, the key of its route on a device.
export const patchKey = (p) => (p?.label || '').trim() || `Canale ${Number(p?.channel) || 1}`;

// Instruments with a patch in these songs (for the routes of a device), in order of appearance.
export function instrumentsOf(items = []) {
  const seen = new Set();
  items.forEach((it) => (it?.midi || []).forEach((p) => seen.add(patchKey(p))));
  return [...seen];
}

export const ROUTE_OFF = 'off';

// Something to send to on this device: the output, or the output of an instrument.
export const hasMidiTarget = (output, routes = {}) => !!output || Object.values(routes || {}).some((r) => r && r !== ROUTE_OFF);

/**
 * Where the patches go on this device: { [output]: messages[] }.
 * routes: { [instrument]: output | 'off' }; without a route an instrument goes to `output`.
 */
export function routePatches(patches = [], output, routes = {}) {
  const byOut = {};
  patches.forEach((p) => {
    const route = routes?.[patchKey(p)];
    const out = route === ROUTE_OFF ? null : route || output;
    if (!out) return;
    const msgs = patchMessages(p);
    if (msgs.length) (byOut[out] ||= []).push(...msgs);
  });
  return byOut;
}

const num = (v) => (v == null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Clean patch for Firestore (from the editor's draft). */
export function cleanPatch(p) {
  const cc = parseCc(p.cc);
  const sysex = String(p.sysex || '').trim().toUpperCase();
  return {
    label: (p.label || '').trim(),
    name: (p.name || '').trim(),
    channel: num(p.channel) ?? 1,
    program: num(p.program),
    bankMsb: num(p.bankMsb),
    bankLsb: num(p.bankLsb),
    ...(cc.length ? { cc } : {}),
    ...(sysex && parseSysex(sysex).length ? { sysex } : {}),
  };
}

export const patchHasData = (p) => !!(p.label || given(p.program) || parseCc(p.cc).length || parseSysex(p.sysex).length);
