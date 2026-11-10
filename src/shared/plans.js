// Subscription plans and what each one allows. Shared with the desktop
// (scripts/sync-shared.mjs): every app reads the plan and the usage the same way.
//
// users/{uid}.plan  = { tier: 'free'|'plus'|'pro', source: 'manual'|'play'|'stripe', expiresAt?, note?, updatedAt,
//                       interval?: 'month'|'year', status?, cancelAtPeriodEnd? (Stripe and Play),
//                       subscriptionId? (Stripe), purchaseId?, productId? (Play) }
//                     written only by the super admin (manual) or by the server (purchases).
// users/{uid}.usage = { songs, bytes, updatedAt }
//                     counted by the Cloud Functions (functions/index.js), never by the apps:
//                     songs = library songs owned, bytes = files in the LiveTools cloud they own.
// users/{uid}.billing = { stripeCustomerId?, playAccountId?, trialUsed? }  written only by the server.
// config/app.plansEnforced: until true the limits are only shown, not applied.
//
// Purchases: Google Play inside the Android app, Stripe from the web (and from the
// desktop, which opens the web page). Either way the plan is the same on every app.
// Prices are shown here; the ones charged are the Stripe prices with the lookup keys
// of stripeLookupKey() (functions/scripts/stripe-setup.mjs creates them) and, on
// Android, the Play subscriptions livetools_plus / livetools_pro (mobile/scripts/play-setup.mjs).

export const GB = 1024 ** 3;

export const PLANS = {
  free: {
    id: 'free',
    label: 'Free',
    songs: 10,
    storage: 0,
    media: 'local', // audio and video stay on the computer
    team: false,
    price: null,
    summary: 'Fino a 10 brani, file audio e video solo su questo computer.',
  },
  plus: {
    id: 'plus',
    label: 'Plus',
    songs: Infinity,
    storage: 0,
    media: 'drive', // files on the user's Google Drive
    team: false,
    price: { month: 4.99, year: 39.99 },
    trialDays: 7,
    summary: 'Brani illimitati, file audio e video sul tuo Google Drive.',
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    songs: Infinity,
    storage: 25 * GB,
    media: 'cloud', // files in the LiveTools cloud, MP3 only
    team: true,
    members: 6,
    price: { month: 9.99, year: 89.99 },
    trialDays: 14,
    summary: 'Brani illimitati, 25 GB nel cloud LiveTools e condivisione con la band.',
  },
};

export const PLAN_IDS = Object.keys(PLANS);
// Plans that can be bought.
export const PAID_PLAN_IDS = PLAN_IDS.filter((id) => PLANS[id].price);
export const INTERVALS = { month: 'mese', year: 'anno' };

/** Lookup key of the Stripe price of a plan: livetools_plus_month, livetools_pro_year… */
export const stripeLookupKey = (tier, interval) => `livetools_${tier}_${interval}`;

/** "4,99 €" */
export const formatPrice = (n) =>
  `${Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Months saved by the yearly price against twelve monthly ones (rounded down). */
export const yearSaving = (plan) => (plan?.price ? Math.floor(12 - plan.price.year / plan.price.month) : 0);

export const SOURCE_LABELS = { manual: 'assegnato dall’amministratore', play: 'Google Play', stripe: 'pagamento online' };

// The super admin has no limits, whatever plan is written on the profile.
export const ADMIN_PLAN = {
  id: 'admin',
  label: 'Super admin',
  songs: Infinity,
  storage: Infinity,
  media: 'cloud',
  team: true,
  summary: 'Nessun limite: sei il super admin di LiveTools.',
};

// Share of a limit after which the apps warn.
export const WARN_AT = 0.8;

const millis = (t) => (t?.toMillis ? t.toMillis() : typeof t === 'number' ? t : t ? Date.parse(t) : null);

/** The plan in force for a user profile: an expired or missing plan is Free. */
export function planOf(profile, now = Date.now()) {
  const p = profile?.plan;
  const exp = millis(p?.expiresAt);
  if (!p || !PLANS[p.tier] || (exp && exp < now)) return PLANS.free;
  return PLANS[p.tier];
}

/** Usage of a profile, with the limits of its plan: { plan, songs, bytes, songLimit, storageLimit }. */
export function usageOf(profile, { superAdmin = false } = {}) {
  const plan = superAdmin ? ADMIN_PLAN : planOf(profile);
  const u = profile?.usage || {};
  return {
    plan,
    songs: Math.max(0, Number(u.songs) || 0),
    bytes: Math.max(0, Number(u.bytes) || 0),
    songLimit: plan.songs,
    storageLimit: plan.storage,
    updatedAt: millis(u.updatedAt),
  };
}

/** 0..1 (or more, over the limit) of a used amount; 0 with no limit. */
export const share = (used, limit) => (Number.isFinite(limit) && limit > 0 ? used / limit : 0);

/** 'ok' | 'warn' | 'full' for a used amount against its limit. */
export function level(used, limit) {
  if (!Number.isFinite(limit)) return 'ok';
  if (limit <= 0) return used > 0 ? 'full' : 'ok';
  const s = used / limit;
  return s >= 1 ? 'full' : s >= WARN_AT ? 'warn' : 'ok';
}

export function formatBytes(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b >= GB) return `${(b / GB).toLocaleString('it-IT', { maximumFractionDigits: 1 })} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2).toLocaleString('it-IT')} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

/** Where the plan in force comes from ('manual' | 'play' | 'stripe'), or null for Free. */
export function planSource(profile, now = Date.now()) {
  return planOf(profile, now).id === 'free' ? null : profile?.plan?.source || 'manual';
}

/** "28 nov 2026" for the end of a plan, or null. */
export function planExpiry(profile) {
  const exp = millis(profile?.plan?.expiresAt);
  return exp ? new Date(exp).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
}
