(function () {
  const FLUSH_INTERVAL = 5000;
  const FLUSH_COUNT = 25;
  const ENDPOINT = '/api/track';

  let queue = [];
  let timer = null;
  let user = {};

  function flush() {
    if (!queue.length) return;
    const batch = queue.splice(0);
    const payload = JSON.stringify({ events: batch, user });
    try {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
    } catch (_) {
      fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(flush, FLUSH_INTERVAL);
  }

  window.sohTrack = function (name, data) {
    queue.push({ name, data: data || {}, url: location.href, ts: Date.now() });
    if (queue.length >= FLUSH_COUNT) flush();
    else schedule();
  };

  window.sohSetUser = function (u) { user = { ...user, ...u }; };

  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);
})();
