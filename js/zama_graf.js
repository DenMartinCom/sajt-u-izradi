// ===== ZAMA STAKING GRAFIKON =====
(function () {
  const WORKER_URL = 'https://kripto-consumer.martin-denic.workers.dev';
  const CANVAS_ID = 'zama-chart';
  const STATUS_ID = 'zama-graf-status';
  const REFRESH_MS = 10 * 60 * 1000;

  let chart = null;

  function setStatus(txt) {
    const el = document.getElementById(STATUS_ID);
    if (el) el.textContent = txt;
  }

  async function load() {
    const canvas = document.getElementById(CANVAS_ID);
    if (!canvas || typeof Chart === 'undefined') return;
    setStatus('Učitavanje...');
    try {
      const r = await fetch(`${WORKER_URL}/zama-stacking?dana=400`);
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
              label: (ctx) => {
                if (ctx.datasetIndex === 0) {
                  const v = Number(ctx.parsed.y);
                  return 'Staked: ' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' ZAMA';
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
              callback: (v) => {
                const n = Number(v);
                if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
                if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
                return n.toFixed(0);
              }
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
  }

  function start() {
    load();
    setInterval(load, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
