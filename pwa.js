// Installable app: service worker, an "Install app" button where the browser offers one,
// and a one-line Add to Home Screen hint on iOS Safari.
(() => {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
    });
  }

  const installed = () => matchMedia('(display-mode: standalone)').matches ||
    matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  const btn = document.getElementById('installBtn');
  const iosHint = document.getElementById('iosHint');
  if (!btn || !iosHint || installed()) return;

  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (!deferred) return;
    btn.hidden = true;
    deferred.prompt();
    try { await deferred.userChoice; } catch (e) {}
    deferred = null;
  });
  window.addEventListener('appinstalled', () => { btn.hidden = true; iosHint.hidden = true; });

  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA/.test(ua);
  if (iOS && safari) iosHint.hidden = false;
})();
