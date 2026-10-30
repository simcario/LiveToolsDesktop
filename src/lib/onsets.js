// Transients of the local tracks (Rust side), for the warp magnet. Computed
// once per file and kept for the session.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const cache = new Map(); // local path → Promise<number[]>

export function loadOnsets(path) {
  if (!cache.has(path)) {
    const p = invoke('track_onsets', { path }).catch((e) => {
      cache.delete(path);
      throw e;
    });
    cache.set(path, p);
  }
  return cache.get(path);
}

/** Transients of a local file, null while they are computed (or without a path). */
export function useOnsets(path) {
  const [state, setState] = useState({ path: null, onsets: null });
  useEffect(() => {
    if (!path) return undefined;
    let alive = true;
    loadOnsets(path)
      .then((onsets) => alive && setState({ path, onsets }))
      .catch(() => alive && setState({ path, onsets: [] }));
    return () => {
      alive = false;
    };
  }, [path]);
  return state.path === path ? state.onsets : null;
}
