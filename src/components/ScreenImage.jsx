import { useRef, useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { deleteMediaFile, uploadMedia } from '../shared/media.js';
import { explainDenied } from '../shared/planGuard.js';
import { db, storage } from '../lib/firebase';
import Icon from './Icon';

// Picture of the setlist for the video output (window and NDI) when there is no
// video to show: setlist.screenImage = { id, name, file, path, size, type }, the
// same for the whole band. The file goes with the setlist's media, as a score
// (images up to 20 MB are allowed by every plan).
export const SCREEN_IMAGE_TYPES = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';
const MAX_BYTES = 20 * 1024 * 1024;
export const screenTarget = (setlistId) => ({ setlistId, itemId: 'screen' });

export default function ScreenImage({ setlist, canEdit, notify }) {
  const input = useRef(null);
  const [progress, setProgress] = useState(null);
  const image = setlist?.screenImage?.path ? setlist.screenImage : null;
  const target = screenTarget(setlist.id);
  const save = (screenImage) => updateDoc(doc(db, 'setlists', setlist.id), { screenImage, updatedAt: serverTimestamp() });

  const pick = async (file) => {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) return notify('Scegli un’immagine JPG, PNG o WebP.', true);
    if (file.size >= MAX_BYTES) return notify('L’immagine supera i 20 MB.', true);
    setProgress(0);
    try {
      const media = await uploadMedia(storage, target, file, (p) => setProgress(p)).promise;
      await save(media);
      if (image) await deleteMediaFile(storage, image.path, target).catch(() => {});
      notify(`Immagine dello schermo: “${file.name}”`);
    } catch (e) {
      notify(`Immagine non caricata: ${explainDenied(e)}`, true);
    } finally {
      setProgress(null);
    }
  };

  const remove = async () => {
    try {
      await save(null);
      await deleteMediaFile(storage, image.path, target).catch(() => {});
    } catch (e) {
      notify(`Immagine non tolta: ${explainDenied(e)}`, true);
    }
  };

  return (
    <>
      <Icon name="monitor" size={14} />
      <span className="small ellipsis" style={{ maxWidth: 160 }} title={image ? `Sull’uscita video quando non c’è un video: ${image.file}` : 'Nessuna immagine: senza video l’uscita resta nera'}>
        {progress != null ? `Carico ${Math.round(progress * 100)}%` : image ? image.name : 'Schermo nero'}
      </span>
      {canEdit && (
        <>
          <button className="btn btn-sm" onClick={() => input.current?.click()} disabled={progress != null} title="Immagine da proiettare sull’uscita video quando non c’è un video">
            {image ? 'Cambia' : 'Immagine…'}
          </button>
          {image && (
            <button className="btn btn-sm btn-icon btn-ghost" onClick={remove} title="Togli l’immagine: senza video l’uscita resta nera" aria-label="Togli l’immagine">
              <Icon name="x" size={12} />
            </button>
          )}
          <input
            ref={input}
            type="file"
            accept={SCREEN_IMAGE_TYPES}
            hidden
            onChange={(e) => {
              pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </>
      )}
    </>
  );
}
