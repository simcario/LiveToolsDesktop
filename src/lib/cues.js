// Slide changes of the prompter (shared with the output window, which never loads Firebase).
import { cueIndexAt, slideTags } from '../shared/prompter.js';

export { cueIndexAt };

/** Cue on screen in the Gobbo output (`source` of usePrompterOutput) at engine status `s`. */
export const outputCueIndex = (source, s) =>
  s.songId && s.songId === source?.itemId ? cueIndexAt(source.cues || [], s.position + (source.lead || 0)) : -1;

/** Slide on screen at cue `index` and the next one, when the output shows it. */
export function outputSlides(source, index) {
  const cues = source?.cues || [];
  const slides = source?.slides || [];
  const current = index >= 0 ? slides.find((s) => s.id === cues[index].slide) : null;
  // Before the first change, the first slide waits as "next".
  const nextCue = cues.slice(index + 1).find((c) => c.slide);
  const next = nextCue && slides.find((s) => s.id === nextCue.slide);
  return { current, next: source?.showNext && next && next !== current ? next : null };
}

/**
 * The Gobbo sent to the Leggio of the band's phones and tablets (local network, Telecomando):
 * `source` of usePrompterOutput without the planned order. Null without slides.
 */
export function prompterShare(source) {
  if (!source?.itemId || !source.slides?.length) return null;
  const { itemId, title, lead, showNext, slides, cues } = source;
  return { itemId, title: title || '', lead: lead || 0, showNext: !!showNext, slides: slides.map((s) => ({ id: s.id, label: s.label || '', text: s.text || '', tags: slideTags(s) })), cues };
}
