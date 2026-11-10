// The Free plan works on one device only: the first one used with the account.
// Its audio and video stay on that device (media.js, store 'local') and the
// account cannot be used from any other one (another computer, the web, the
// tablet) until it moves to Plus or Pro, or the super admin frees the device.
//
// users/{uid}.device = { id, platform: 'desktop'|'web'|'tablet', name, at }
// written once by the user (firestore.rules), changed only by the super admin.
// The id is a random one kept in this app's storage. Shared with the desktop and
// the tablet app (scripts/sync-shared.mjs).
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { planOf } from './plans';

const KEY = 'livetools.deviceId';
let cached = null;

/** This device's id (created the first time). */
export function deviceId() {
  if (cached) return cached;
  try {
    cached = localStorage.getItem(KEY);
    if (!cached) {
      cached = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(KEY, cached);
    }
  } catch {
    cached ??= `tmp-${Math.random().toString(36).slice(2)}`;
  }
  return cached;
}

export const PLATFORM_LABELS = { desktop: 'LiveTools per computer', web: 'LiveTools nel browser', tablet: 'LiveTools per tablet' };

export function devicePlatform() {
  if (typeof window === 'undefined') return 'web';
  if (!window.__TAURI_INTERNALS__) return 'web';
  return /android|iphone|ipad/i.test(navigator.userAgent) ? 'tablet' : 'desktop';
}

function deviceName() {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = /windows/i.test(ua) ? 'Windows' : /android/i.test(ua) ? 'Android' : /iphone|ipad/i.test(ua) ? 'iOS' : /mac os/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Linux' : '';
  const browser = devicePlatform() !== 'web' ? '' : /edg\//i.test(ua) ? 'Edge' : /chrome\//i.test(ua) ? 'Chrome' : /firefox\//i.test(ua) ? 'Firefox' : /safari\//i.test(ua) ? 'Safari' : '';
  return [browser, os].filter(Boolean).join(' su ') || 'dispositivo';
}

/** "LiveTools per computer (Windows)" */
export const deviceLabel = (device) =>
  device ? `${PLATFORM_LABELS[device.platform] || 'LiveTools'}${device.name ? ` (${device.name})` : ''}` : '';

const isFree = (profile, superAdmin) => !superAdmin && planOf(profile).id === 'free';

/**
 * Free account and no device yet: this one becomes its device. Called by every
 * app once the profile is known; nothing happens for paid plans.
 */
export async function registerDevice(uid, profile, { superAdmin } = {}) {
  if (!uid || !profile || profile.device?.id || !isFree(profile, superAdmin)) return;
  await updateDoc(doc(db, 'users', uid), {
    device: { id: deviceId(), platform: devicePlatform(), name: deviceName(), at: serverTimestamp() },
  });
}

/**
 * Free account in use on another device, with the limits on: this app cannot be
 * used here. Returns that device ({ id, platform, name }) or null.
 */
export function blockedBy(profile, { enforced, superAdmin } = {}) {
  if (!enforced || !profile || !isFree(profile, superAdmin)) return null;
  const d = profile.device;
  return d?.id && d.id !== deviceId() ? d : null;
}

/** This is the device of the Free account (its local files are here). */
export const isThisDevice = (profile) => !!profile?.device?.id && profile.device.id === deviceId();
