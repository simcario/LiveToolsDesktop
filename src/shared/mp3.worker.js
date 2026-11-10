// Encodes in MP3 the samples sent by mp3.js (toMp3), away from the interface.
import { encodePcm } from './mp3encode';

self.onmessage = ({ data }) => {
  try {
    const bytes = encodePcm(data, { onProgress: (progress) => self.postMessage({ progress }) });
    self.postMessage({ bytes }, [bytes.buffer]);
  } catch (e) {
    self.postMessage({ error: e?.message || String(e) });
  }
};
self.postMessage({ ready: true });
