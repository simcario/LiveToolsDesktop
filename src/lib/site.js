// The product website: what LiveTools is, guides, downloads, privacy.
import { openUrl } from '@tauri-apps/plugin-opener';

export const SITE = 'https://livetoolsdaw.com';
export const SITE_LABEL = 'livetoolsdaw.com';

export const openSite = (path = '') => openUrl(`${SITE}${path}`).catch(() => {});
