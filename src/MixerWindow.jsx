import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import MixerPanel from './components/MixerPanel';

// The mixer in its own window (F3, as Cubase's MixConsole): it shows the state
// sent by the main window and sends every command back to it (lib/useMixer.js).
const dispatch = (action) => emit('mixer-action', action);

export default function MixerWindow() {
  const [state, setState] = useState(null);
  useEffect(() => {
    const un = listen('mixer-state', (e) => setState(e.payload));
    emit('mixer-hello');
    const onKey = (e) => {
      if (e.target.closest?.('select')) return;
      if (e.key === 'F3') {
        e.preventDefault();
        dispatch({ type: 'window' });
      } else if (e.code === 'Space') {
        e.preventDefault();
        dispatch({ type: 'play' });
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
        e.preventDefault();
        dispatch({ type: 'save' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      un.then((f) => f());
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  return <div className="mixer-window">{state ? <MixerPanel state={state} dispatch={dispatch} inWindow /> : <span className="video-empty">LiveTools · mixer</span>}</div>;
}
