import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEngineStatus } from './lib/engine';
import { outputCueIndex, outputSlides } from './lib/cues';
import SlideText from './components/SlideText';

// Second window for the singers' screen: the slide of the song in the player
// at the position of the audio engine. Double click: full screen.
// The NDI output draws the same picture (lib/ndi.js).
export default function PrompterWindow() {
  const [source, setSource] = useState(null);

  useEffect(() => {
    const un = listen('prompter-source', (e) => setSource(e.payload));
    emit('prompter-hello');
    return () => {
      un.then((f) => f());
    };
  }, []);

  const index = useEngineStatus((s) => outputCueIndex(source, s));
  const { current, next } = outputSlides(source, index);

  const toggleFullscreen = async () => {
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  };

  return (
    <div className="prompter-window" onDoubleClick={toggleFullscreen} style={{ cursor: source ? 'none' : 'default' }}>
      {!source ? (
        <span className="video-empty">LiveTools · gobbo — doppio clic per lo schermo intero</span>
      ) : (
        <>
          <SlideText text={current?.text} className="pw-current" />
          {next && <SlideText text={next.text} className="pw-next" max={48} />}
        </>
      )}
    </div>
  );
}
