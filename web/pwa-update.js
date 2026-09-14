// Shared page half of pwa-kit. The worker takes over immediately, while the
// editor decides when reloading is safe for the project currently in flight.

const RELOADED_KEY = 'pwa-kit:updated';

function defaultToast(message) {
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.textContent = message;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  Object.assign(el.style, {
    position: 'fixed',
    top: 'max(14px, calc(env(safe-area-inset-top) + 10px))',
    left: '50%',
    transform: 'translateX(-50%)',
    background: dark ? '#eff3ed' : '#17201c',
    color: dark ? '#17201c' : '#eff3ed',
    padding: '11px 18px',
    borderRadius: '99px',
    font: '600 14px/1.3 system-ui, sans-serif',
    boxShadow: '0 6px 24px rgba(0,0,0,.28)',
    maxWidth: '90vw',
    textAlign: 'center',
    zIndex: '2147483647',
    opacity: still ? '1' : '0',
    transition: still ? 'none' : 'opacity .2s ease'
  });
  document.body.appendChild(el);
  if (!still) requestAnimationFrame(() => { el.style.opacity = '1'; });
  setTimeout(() => {
    if (still) return el.remove();
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

export function installUpdates({
  appName = 'The app',
  message = null,
  toast = defaultToast,
  isBusy = () => false,
  scriptUrl = '/sw.js'
} = {}) {
  if (!('serviceWorker' in navigator)) return;

  if (sessionStorage.getItem(RELOADED_KEY)) {
    sessionStorage.removeItem(RELOADED_KEY);
    toast(message || `${appName} updated to the latest version`);
  }

  const start = async () => {
    let registration;
    try {
      registration = await navigator.serviceWorker.register(scriptUrl, {
        updateViaCache: 'none'
      });
    } catch (error) {
      console.warn('service worker did not register:', error);
      return;
    }

    registration.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });

    let reloading = false;
    const reload = () => {
      if (reloading) return;
      reloading = true;
      sessionStorage.setItem(RELOADED_KEY, '1');
      location.reload();
    };

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type !== 'sw-updated') return;
      event.source?.postMessage?.({ type: 'sw-update-ack' });
      navigator.serviceWorker.controller?.postMessage({ type: 'sw-update-ack' });

      if (!isBusy()) return reload();
      const settle = setInterval(() => {
        if (!isBusy()) {
          clearInterval(settle);
          reload();
        }
      }, 2000);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          clearInterval(settle);
          reload();
        }
      }, { once: true });
    });
  };

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
