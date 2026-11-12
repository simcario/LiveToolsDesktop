import { useCallback, useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import SyncedVideo from './SyncedVideo';

let nextKey = 1;

/**
 * Video layers after a `video-source` message: at most one following the engine (the
 * song loaded) and one tail fading out. When the song that leaves is the tail, its own
 * layer (same key, same <video> element) becomes the tail: a new element would have to
 * load the file again and the picture would blink at the change of song.
 */
function nextLayers(layers, payload) {
  const { tail } = payload || {};
  const live = layers.find((l) => !l.tail);
  let out = layers.filter((l) => l.tail);
  if (tail) {
    out = live?.src === tail.src ? [{ ...live, tail }] : [{ key: nextKey++, src: tail.src, offset: tail.offset || 0, fades: tail.fades, tail }];
  }
  if (payload?.src) {
    const same = live && live.src === payload.src && !tail;
    out.push({ key: same ? live.key : nextKey++, src: payload.src, offset: payload.offset || 0, fades: payload.fades || null, song: payload.song || null, tail: null });
  }
  return out;
}

/**
 * What the video output shows, from the `video-source` messages of usePlayer: the video of
 * the song in the player (in sync with the engine), the one before still fading out on top
 * (tail), and the picture of the setlist under them, seen when there is no video. Used by
 * the video window and by the monitor of the Transizioni page.
 * `children(state)`: what to add over it ({ source, tail, shown }). Class `is-shown` once
 * something was shown.
 */
export default function VideoOutput({ className, children, ...rest }) {
  const [source, setSource] = useState(null);
  const [layers, setLayers] = useState([]);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const un = listen('video-source', (e) => {
      setSource(e.payload);
      setLayers((ls) => nextLayers(ls, e.payload));
      if (e.payload?.src || e.payload?.still) setShown(true);
    });
    // The player answers with the current source.
    un.then(() => emit('video-hello'));
    return () => {
      un.then((f) => f());
    };
  }, []);
  const endTail = useCallback((key) => setLayers((ls) => ls.filter((l) => l.key !== key)), []);
  const tail = layers.some((l) => l.tail);

  return (
    <div className={`${className || ''} ${source?.src || shown ? 'is-shown' : ''}`} {...rest}>
      {/* Picture of the setlist under the videos: seen when there is none (it fades in and
          out). Already there under a tail, so that the video fades out onto it. */}
      {source?.still && <img className={`video-still ${source?.src ? '' : 'is-on'}`} src={source.still} alt="" />}
      {/* Stable order and keys: a <video> moved in the page would stop. The tail stays on top (CSS). */}
      {layers.map((l) => (
        <SyncedVideo key={l.key} src={l.src} offset={l.offset} fades={l.fades} tail={l.tail} song={l.song} onEnd={() => endTail(l.key)} />
      ))}
      {children?.({ source, tail, shown })}
    </div>
  );
}
