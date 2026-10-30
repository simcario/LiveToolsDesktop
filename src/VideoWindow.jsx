import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import SyncedVideo from './components/SyncedVideo';

// Second window for a projector / external screen: shows the video of the
// song in the player, in sync with the audio engine. Double click: full screen.
export default function VideoWindow() {
  const [source, setSource] = useState(null);

  useEffect(() => {
    const un = listen('video-source', (e) => setSource(e.payload));
    emit('video-hello');
    return () => {
      un.then((f) => f());
    };
  }, []);

  const toggleFullscreen = async () => {
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  };

  return (
    <div className="video-window" onDoubleClick={toggleFullscreen} style={{ cursor: source ? 'none' : 'default' }}>
      {source?.src ? (
        <SyncedVideo src={source.src} offset={source.offset || 0} />
      ) : (
        <span className="video-empty">LiveTools · uscita video — doppio clic per lo schermo intero</span>
      )}
    </div>
  );
}
