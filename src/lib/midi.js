// MIDI out of this computer (or tablet): the patches of the song in the player go
// to the keyboards as soon as it becomes the song in the player (loaded, or taken
// over by a transition). The messages and the routes per instrument are those of
// the web app (shared/midi-patch.js); the ports are opened by the Rust side
// (midi.rs on the desktop, the Android plugin "midi" on the tablet).
import { invoke } from '@tauri-apps/api/core';
import { hasMidiTarget, routePatches } from '../shared/midi-patch.js';

/** Names of the MIDI outputs. */
export const midiOutputs = () => invoke('midi_outputs');

/** The MIDI settings send somewhere: the output, or the output of an instrument. */
export const midiTargeted = (midi) => hasMidiTarget(midi?.output, midi?.routes);

/**
 * Sends the patches of `item` as the settings of this device say ({ output, routes }):
 * the number of messages sent, null when the song has no patch.
 */
export async function sendSongMidi(item, midi) {
  const patches = item?.midi || [];
  if (!patches.length) return null;
  const byOut = routePatches(patches, midi?.output, midi?.routes);
  let sent = 0;
  const errors = [];
  for (const [port, messages] of Object.entries(byOut)) {
    try {
      sent += await invoke('midi_send', { port, messages });
    } catch (e) {
      errors.push(String(e?.message || e));
    }
  }
  if (errors.length) throw new Error(errors.join(' · '));
  return sent;
}
