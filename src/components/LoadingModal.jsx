import { useEffect, useState } from 'react';
import { downloadProgress, useMediaCache } from '../lib/mediaCache';

// Song still loading, in the centre of the screen: percentage while its files
// download, a moving bar while it is prepared (grid, cues, engine). It does not
// block the app: on stage you can still stop or pick another song.
export default function LoadingModal({ busy, files }) {
  const cache = useMediaCache();
  const [shown, setShown] = useState(false);
  const active = !!busy;
  const fetching = !!files;

  // A song already on disk loads at once: no flash for a quick reload.
  useEffect(() => {
    if (!active) {
      setShown(false);
      return undefined;
    }
    const id = setTimeout(() => setShown(true), fetching ? 0 : 250);
    return () => clearTimeout(id);
  }, [active, fetching]);

  if (!active || !shown) return null;
  const percent = files ? Math.round(downloadProgress(files, cache) * 100) : null;
  return (
    <div className="load-modal-wrap">
      <div className="load-modal" role="status" aria-live="polite">
        <strong>Brano in caricamento</strong>
        <span className="small muted load-modal-text">{busy}</span>
        <span className="load-modal-bar">
          {files ? (
            <>
              <span className="bar-progress" role="progressbar" aria-label={busy} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                <span style={{ width: `${percent}%` }} />
              </span>
              <span className="small mono">{percent}%</span>
            </>
          ) : (
            <span className="bar-progress is-indeterminate" role="progressbar" aria-label={busy}>
              <span />
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
