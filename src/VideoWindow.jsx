import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import VideoOutput from './components/VideoOutput';

// Second window for a projector / external screen: shows the video of the
// song in the player, in sync with the audio engine. Double click: full screen.
// Once a video has been shown the screen stays black between two videos (never
// the hint text in the middle of a show).
export default function VideoWindow() {
  const toggleFullscreen = async () => {
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  };
  // It opens full screen: Esc brings it back to a window.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') getCurrentWindow().setFullscreen(false).catch(() => {});
      // F4 (as in the main window) switches the output off.
      if (e.key === 'F4') getCurrentWindow().close().catch(() => {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <VideoOutput className="video-window" onDoubleClick={toggleFullscreen}>
      {({ source, tail, shown }) => !source?.src && !source?.still && !tail && !shown && <span className="video-empty">LiveTools · uscita video — doppio clic per lo schermo intero</span>}
    </VideoOutput>
  );
}
