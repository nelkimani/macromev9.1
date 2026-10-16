/* ═══════════════════════════════════════════════════════════════
   MACROME PWA ENGINE
   - Service Worker (sw.js)
   - Web App Manifest (manifest.webmanifest)
   - Install prompt handling
   - Offline/online detection
   - iOS install detection
   ═══════════════════════════════════════════════════════════════ */

(function MacromePWA() {
  'use strict';

  /* ── 1. SERVICE WORKER (real file: sw.js) ─────────────── */
  // manifest.webmanifest, sw.js and /icons are separate files hosted beside index.html.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { scope: './' })
        .then(reg => {
          console.log('[MacromePWA] Offline mode ready', reg.scope);
          reg.addEventListener('updatefound', () => {
            const w = reg.installing;
            if (!w) return;
            w.addEventListener('statechange', () => {
              if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner();
            });
          });
        })
        .catch(err => console.warn('[MacromePWA] Offline mode could not start:', err.message));
    });
    // the service worker tells us when it has fetched a newer index.html
    navigator.serviceWorker.addEventListener('message', ev => {
      if (ev.data && ev.data.type === 'MACROME_UPDATE') showUpdateBanner();
    });
  } else if ('serviceWorker' in navigator) {
    console.log('[MacromePWA] Not on http(s): offline mode needs the app to be hosted on a web address.');
  }

  /* ── 3. INSTALL PROMPT ───────────────────────────────── */
  let deferredPrompt = null;
  const bannerKey = 'macrome-pwa-banner-dismissed';
  const installKey = 'macrome-pwa-installed';

  // Detect if already installed
  const isInstalled = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true ||
    localStorage.getItem(installKey) === 'true';

  // iOS detection
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isSafari = () => /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    console.log('[MacromePWA] Install prompt captured ✅');

    // Show banner after 3s if not dismissed/installed
    if (!isInstalled() && !sessionStorage.getItem(bannerKey)) {
      setTimeout(() => showInstallBanner(), 3000);
    }
  });

  window.addEventListener('appinstalled', () => {
    console.log('[MacromePWA] App installed! 🎉');
    localStorage.setItem(installKey, 'true');
    hideInstallBanner();
    deferredPrompt = null;
    showFloatingToast('🎉 Macrome Electronics installed successfully!', 'success', 3500);
  });

  // iOS Safari: show tip after delay
  if (isIOS() && isSafari() && !isInstalled() && !sessionStorage.getItem(bannerKey)) {
    setTimeout(() => {
      document.getElementById('ios-banner').style.display = 'block';
    }, 4000);
  }

  function showInstallBanner() {
    const b = document.getElementById('pwa-banner');
    if (b && !isInstalled()) b.style.display = 'block';
  }
  function hideInstallBanner() {
    const b = document.getElementById('pwa-banner');
    const i = document.getElementById('ios-banner');
    if (b) b.style.display = 'none';
    if (i) i.style.display = 'none';
  }

  window.installPWA = async function() {
    if (!deferredPrompt) {
      showFloatingToast('ℹ️ Use browser menu to install', 'info', 3000);
      return;
    }
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log('[MacromePWA] User choice:', outcome);
    deferredPrompt = null;
    hideInstallBanner();
    if (outcome === 'dismissed') {
      showFloatingToast('You can install later from the browser menu', 'info', 3000);
    }
  };

  window.dismissBanner = function() {
    hideInstallBanner();
    sessionStorage.setItem(bannerKey, '1');
  };

  /* ── 4. OFFLINE / ONLINE DETECTION ──────────────────── */
  function showOfflineBanner() {
    const el = document.getElementById('offline-toast');
    if (el) { el.style.display = 'flex'; }
    // Add offline indicator to topbar
    const tb = document.getElementById('topbar-status') || createStatusDot();
    if (tb) tb.style.background = '#c0392b';
  }

  function showOnlineBanner() {
    const el = document.getElementById('offline-toast');
    const on = document.getElementById('online-toast');
    if (el) el.style.display = 'none';
    if (on) {
      on.style.display = 'flex';
      setTimeout(() => { on.style.display = 'none'; }, 3000);
    }
    const tb = document.getElementById('topbar-status');
    if (tb) tb.style.background = '#2E14B0';
  }

  function createStatusDot() {
    const dot = document.createElement('div');
    dot.id = 'topbar-status';
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#2E14B0;position:fixed;top:8px;right:8px;z-index:999;border:2px solid white;transition:.3s';
    document.body.appendChild(dot);
    return dot;
  }

  if (!navigator.onLine) showOfflineBanner();
  window.addEventListener('offline', () => { console.log('[MacromePWA] Gone offline'); showOfflineBanner(); });
  window.addEventListener('online',  () => { console.log('[MacromePWA] Back online');  showOnlineBanner(); });

  /* ── 5. UPDATE BANNER ────────────────────────────────── */
  function showUpdateBanner() {
    const b = document.getElementById('update-banner');
    if (b) b.style.display = 'flex';
  }
  window.showUpdateBanner = showUpdateBanner;

  /* ── 6. TOAST HELPER ─────────────────────────────────── */
  function showFloatingToast(msg, type='info', duration=3000) {
    const t = document.createElement('div');
    const bg = type==='success'?'#1B0B69':type==='error'?'#c0392b':'#150857';
    t.style.cssText = `position:fixed;top:72px;left:50%;transform:translateX(-50%);background:${bg};color:#fff;padding:10px 20px;border-radius:50px;font-size:13px;font-weight:700;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.3);white-space:nowrap;font-family:'Plus Jakarta Sans',sans-serif;animation:bannerSlide .3s ease;pointer-events:none;`;
    {const s=splitLeadIcon(msg);if(s.icon)t.insertAdjacentHTML('afterbegin',MI(s.icon,'mi-inline'));t.appendChild(document.createTextNode(s.text));}
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(()=>t.remove(),300); }, duration);
  }

  /* ── 7. DEEPLINK SUPPORT ─────────────────────────────── */
  // If app launched with ?page=X shortcut, navigate there after load
  const urlParams = new URLSearchParams(window.location.search);
  const targetPage = urlParams.get('page');
  if (targetPage) window.__pendingPage = targetPage; // opened after sign-in

  /* ── 8. PWA DISPLAY MODE DETECTION ──────────────────── */
  if (window.matchMedia('(display-mode: standalone)').matches) {
    console.log('[MacromePWA] Running as installed PWA ✅');
    document.documentElement.setAttribute('data-pwa', 'true');
    // Hide bottom-of-screen safe area gaps for standalone mode
    document.documentElement.style.setProperty('--pwa-standalone', '1');
  }

  // ── 9. SCREEN KEEP-AWAKE ─────────────────────────────
  // Screen Wake Lock API requires a Permissions-Policy header to be set by the
  // server and is blocked in iframes/sandboxed pages.
  // We use a safe 3-layer fallback:
  //   Layer 1: Wake Lock API  (works when served from real https server)
  //   Layer 2: NoSleep.js technique (invisible <video> trick)
  //   Layer 3: Periodic user-activity simulation (last resort)
  let wakeLock = null;
  let noSleepVideo = null;

  function startNoSleepVideo() {
    // Classic NoSleep technique: play a tiny looping invisible video
    // This prevents sleep on mobile without needing any permissions
    if (noSleepVideo) return;
    try {
      noSleepVideo = document.createElement('video');
      noSleepVideo.setAttribute('playsinline', '');
      noSleepVideo.setAttribute('muted', '');
      noSleepVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
      // Tiny looping mp4 (1x1 transparent) encoded as data URI
      const src = document.createElement('source');
      src.src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAAGm1kYXQAAAGzABAHAAABthAJMluAQAAABtgAAABsaGR2ZAAAAAAAAAAAAQAAADhlbHN0AAAAAAAAAAEAAAA4AAAABQAAAQAB';
      src.type = 'video/mp4';
      noSleepVideo.appendChild(src);
      noSleepVideo.loop = true;
      document.body.appendChild(noSleepVideo);
      noSleepVideo.play().catch(() => {
        // Autoplay blocked — that's fine, screen will sleep normally
        noSleepVideo.remove();
        noSleepVideo = null;
      });
      console.log('[MacromePWA] NoSleep video technique active ✅');
    } catch(e) {
      console.log('[MacromePWA] NoSleep video failed:', e.message);
    }
  }

  async function requestWakeLock() {
    // Layer 1: Wake Lock API — only try if page is visible and on https
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
          console.log('[MacromePWA] Wake lock released');
        });
        console.log('[MacromePWA] Wake Lock API active ✅');
        return; // Success — no need for fallbacks
      } catch (err) {
        // NotAllowedError = permissions policy blocked (iframe, sandbox, non-https)
        // AbortError = page not visible
        // Both are expected — fall through silently to Layer 2
        if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
          console.log('[MacromePWA] Wake Lock unavailable (' + err.name + ') — using video fallback');
        }
      }
    }
    // Layer 2: NoSleep video (no permissions needed, works on mobile browsers)
    startNoSleepVideo();
  }

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      if (wakeLock === null) await requestWakeLock();
      if (noSleepVideo && noSleepVideo.paused) noSleepVideo.play().catch(() => {});
    } else {
      // Release wake lock when page hidden to save battery
      if (wakeLock) { try { await wakeLock.release(); } catch(_) {} wakeLock = null; }
    }
  });

  /* ── 10. KEYBOARD SHORTCUT HINTS ────────────────────── */
  document.addEventListener('keydown', (e) => {
    if (e.altKey) {
      const map = { 'd':'dashboard','p':'pos','i':'inventory','r':'reports','s':'settings' };
      const pg = map[e.key.toLowerCase()];
      if (pg && typeof go === 'function') {
        e.preventDefault();
        const nav = document.querySelector(`[data-page="${pg}"]`);
        go(pg, nav);
      }
    }
  });

  // Kick off screen keep-awake (triggered on first user interaction to comply
  // with autoplay policies — not called blindly on page load)
  let wakeStarted = false;
  function startWakeOnInteraction() {
    if (wakeStarted) return;
    wakeStarted = true;
    requestWakeLock();
    document.removeEventListener('click', startWakeOnInteraction);
    document.removeEventListener('touchstart', startWakeOnInteraction);
  }
  document.addEventListener('click', startWakeOnInteraction, { passive: true });
  document.addEventListener('touchstart', startWakeOnInteraction, { passive: true });

  console.log('[MacromePWA] ✅ PWA engine ready — Macrome Electronics POS');
})(); // end MacromePWA IIFE
