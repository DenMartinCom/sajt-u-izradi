// ===== ZAMA STAKING GRAFIKON =====
(function () {
  const WORKER_URL = 'https://kripto-consumer.martin-denic.workers.dev';
  const CANVAS_ID = 'zama-chart';
  const STATUS_ID = 'zama-graf-status';
  const PERIOD_ID = 'zama-graf-period';
  const REFRESH_MS = 10 * 60 * 1000;

  let chart = null;
  let trenutniDana = 400;

  function setStatus(txt) {
    const el = document.getElementById(STATUS_ID);
    if (el) el.textContent = txt;
  }

  function formatBrojB(v) {
    const n = Number(v);
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  }

  async function load(dana) {
    if (dana) trenutniDana = dana;
    const canvas = document.getElementById(CANVAS_ID);
    if (!canvas || typeof Chart === 'undefined') return;
    setStatus('Učitavanje...');
    try {
      const r = await fetch(`${WORKER_URL}/zama-stacking?dana=${trenutniDana}`);
      const d = await r.json();
      if (!d || !d.ok || !Array.isArray(d.tacke) || !d.tacke.length) {
        setStatus('Nema podataka');
        return;
      }
      nacrtaj(d.tacke);
      setStatus(`Ažurirano: ${new Date().toLocaleTimeString('sr-RS')} (${d.tacke.length} tačaka)`);
    } catch (e) {
      setStatus('Greška: ' + e.message);
    }
  }

  function nacrtaj(tacke) {
    const canvas = document.getElementById(CANVAS_ID);
    const labels = tacke.map(t => {
      const d = new Date(t.t);
      return d.getDate() + '.' + (d.getMonth() + 1) + '.';
    });
    const u = tacke.map(t => t.u);
    const a = tacke.map(t => t.a);

    if (chart) {
      chart.data.labels = labels;
      chart.data.datasets[0].data = u;
      chart.data.datasets[1].data = a;
      chart.$tacke = tacke;
      chart.update('none');
      return;
    }

    chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Staked ZAMA',
            data: u,
            borderColor: '#FFD700',
            backgroundColor: 'rgba(255,215,0,0.10)',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
            fill: true,
            yAxisID: 'y'
          },
          {
            label: 'APR (%)',
            data: a,
            borderColor: '#4caf50',
            backgroundColor: 'rgba(76,175,80,0.08)',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
            fill: false,
            yAxisID: 'y1',
            spanGaps: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#e0e0e0',
              font: { size: 10 },
              boxWidth: 12,
              padding: 8
            }
          },
          tooltip: {
            callbacks: {
              title: (items) => {
                if (!items.length || !chart.$tacke) return '';
                const t = chart.$tacke[items[0].dataIndex];
                if (!t) return '';
                const d = new Date(t.t);
                const dd = String(d.getDate()).padStart(2, '0');
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const hh = String(d.getHours()).padStart(2, '0');
                const mi = String(d.getMinutes()).padStart(2, '0');
                return `${dd}.${mm}.${d.getFullYear()}. ${hh}:${mi}`;
              },
              label: (ctx) => {
                if (ctx.datasetIndex === 0) {
                  return 'Staked: ' + formatBrojB(ctx.parsed.y) + ' ZAMA';
                }
                return 'APR: ' + (ctx.parsed.y != null ? Number(ctx.parsed.y).toFixed(2) + '%' : '—');
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: '#888',
              font: { size: 9 },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 5
            }
          },
          y: {
            position: 'left',
            grid: { color: 'rgba(255,215,0,0.08)' },
            ticks: {
              color: '#FFD700',
              font: { size: 9 },
              callback: (v) => formatBrojB(v)
            }
          },
          y1: {
            position: 'right',
            grid: { display: false },
            ticks: {
              color: '#4caf50',
              font: { size: 9 },
              callback: (v) => Number(v).toFixed(2) + '%'
            }
          }
        }
      }
    });
    chart.$tacke = tacke;
  }

  function start() {
    load(400);

    const sel = document.getElementById(PERIOD_ID);
    if (sel) {
      sel.addEventListener('change', () => {
        const v = parseInt(sel.value, 10);
        if (isFinite(v) && v > 0) load(v);
      });
    }

    setInterval(() => load(), REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();