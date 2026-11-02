// Slide changes of the prompter (shared with the output window, which never loads Firebase).
import { cueIndexAt } from '../shared/prompter.js';

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
