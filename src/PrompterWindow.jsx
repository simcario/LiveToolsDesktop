import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEngineStatus } from './lib/engine';
import { cueIndexAt } from './lib/cues';
import SlideText from './components/SlideText';

// Second window for the singers' screen: the slide of the song in the player
// at the position of the audio engine. Double click: full screen.
export default function PrompterWindow() {
  const [source, setSource] = useState(null);

  useEffect(() => {
    const un = listen('prompter-source', (e) => setSource(e.payload));
    emit('prompter-hello');
    return () => {
      un.then((f) => f());
    };
  }, []);

  const cues = source?.cues || [];
  const lead = source?.lead || 0;
  const index = useEngineStatus((s) => (s.songId && s.songId === source?.itemId ? cueIndexAt(cues, s.position + lead) : -1));
  const slides = source?.slides || [];
  const current = index >= 0 ? slides.find((s) => s.id === cues[index].slide) : null;
  // Before the first change, the first slide waits as "next".
  const nextCue = cues.slice(index + 1).find((c) => c.slide);
  const next = nextCue && slides.find((s) => s.id === nextCue.slide);

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
          {source.showNext && next && next !== current && <SlideText text={next.text} className="pw-next" max={48} />}
        </>
      )}
    </div>
  );
}
