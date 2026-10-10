// ===== ZAMA STAKING GRAFIKON (DEBUG 2) =====
(function () {
  const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
  const WORKER_URL = 'https://kripto-consumer.martin-denic.workers.dev';
  const CANVAS_ID = 'zama-chart';
  const STATUS_ID = 'zama-graf-status';

  function setStatus(txt) {
    const el = document.getElementById(STATUS_ID);
    if (el) el.textContent = txt;
  }

  async function load() {
    const canvas = document.getElementById(CANVAS_ID);
    if (!canvas) { setStatus('nema canvas'); return; }
    if (typeof Chart === 'undefined') { setStatus('nema Chart'); return; }

    setStatus('fetch...');
    try {
      const url = `${WORKER_URL}/zama-stacking?dana=400&_=${Date.now()}`;
      const res = await fetch(url);
      const txt = await res.text();
      if (!res.ok) { setStatus('HTTP ' + res.status + ': ' + txt.slice(0, 200)); return; }
      let d = null;
      try { d = JSON.parse(txt); } catch (e) { setStatus('parse fail: ' + txt.slice(0, 200)); return; }
      if (!d) { setStatus('d null'); return; }
      if (!d.ok) { setStatus('raw: ' + txt.slice(0, 250)); return; }
      if (!Array.isArray(d.tacke)) { setStatus('nema tacke, kljucevi: ' + Object.keys(d).join(',')); return; }
      setStatus('OK: ' + d.tacke.length + ' tacaka');
    } catch (e) {
      setStatus('fetch greska: ' + e.message);
    }
  }

  function start() { load(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
