// Splash screen (inline in index.html, so it paints before the bundle loads).
// It stays at least SPLASH_MIN_MS from the page start, then fades out.
const SPLASH_MIN_MS = 1200;

export function hideSplash() {
  const el = document.getElementById('splash');
  if (!el || el.classList.contains('is-out')) return;
  // performance.now() counts from the start of the page load.
  setTimeout(() => {
    el.classList.add('is-out');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 1000); // transitionend may never fire (reduced motion, hidden window)
  }, Math.max(0, SPLASH_MIN_MS - performance.now()));
}
