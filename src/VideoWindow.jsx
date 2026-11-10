import { useCallback, useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import SyncedVideo, { TailVideo } from './components/SyncedVideo';

// Second window for a projector / external screen: shows the video of the
// song in the player, in sync with the audio engine. Double click: full screen.
// Once a video has been shown the screen stays black between two videos (never
// the hint text in the middle of a show).
export default function VideoWindow() {
  const [source, setSource] = useState(null);
  const [tail, setTail] = useState(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const un = listen('video-source', (e) => {
      setSource(e.payload);
      if (e.payload?.src || e.payload?.still) setShown(true);
      if (e.payload?.tail) setTail(e.payload.tail);
    });
    emit('video-hello');
    return () => {
      un.then((f) => f());
    };
  }, []);
  const endTail = useCallback(() => setTail(null), []);

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
    <div className="video-window" onDoubleClick={toggleFullscreen} style={{ cursor: source?.src || shown ? 'none' : 'default' }}>
      {/* Picture of the setlist under the videos: seen when there is none (it fades in and out). */}
      {source?.still && <img className={`video-still ${source?.src || tail ? '' : 'is-on'}`} src={source.still} alt="" />}
      {source?.src && <SyncedVideo src={source.src} offset={source.offset || 0} fades={source.fades} />}
      {tail && <TailVideo key={`${tail.src}:${tail.since}`} tail={tail} onEnd={endTail} />}
      {!source?.src && !source?.still && !tail && !shown && <span className="video-empty">LiveTools · uscita video — doppio clic per lo schermo intero</span>}
    </div>
  );
}
