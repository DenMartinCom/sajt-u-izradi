
// ===== GRAFIKON "Uk." vrednosti kroz vreme =====
// Vrednost dolazi iz gas widgeta (desno od "Uk.")
// Istorija se čuva u localStorage (samo kod ovog posetioca)

(function () {
    const STORAGE_KEY = 'uk_history_v1';
    const MAX_POINTS = 100; // koliko poslednjih tačaka čuvamo

    let chart = null;
    let history = [];

    // --- Učitaj istoriju iz localStorage ---
    function ucitajIstoriju() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        } catch (e) {
            console.warn('Grafikon: ne mogu da učitam istoriju:', e);
        }
        return [];
    }

    // --- Sačuvaj istoriju u localStorage ---
    function sacuvajIstoriju() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
        } catch (e) {
            console.warn('Grafikon: ne mogu da sačuvam istoriju:', e);
        }
    }

    // --- Formatiraj vreme za labelu (HH:MM:SS) ---
    function formatVreme(ts) {
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    }

    // --- Inicijalizacija Chart.js ---
    function initChart() {
        const canvas = document.getElementById('uk-chart');
        if (!canvas || typeof Chart === 'undefined') return;

        history = ucitajIstoriju();

        const labels = history.map(p => formatVreme(p.t));
        const data = history.map(p => p.v);

        chart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Uk. ($)',
                    data: data,
                    borderColor: '#FFD700',
                    backgroundColor: 'rgba(255, 215, 0, 0.15)',
                    borderWidth: 2,
                    pointRadius: 2,
                    pointHoverRadius: 5,
                    pointBackgroundColor: '#FFD700',
                    tension: 0.3,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 400 },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => 'Uk.: $' + Number(ctx.parsed.y).toFixed(4)
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: {
                            color: '#888',
                            maxRotation: 0,
                            autoSkip: true,
                            maxTicksLimit: 6,
                            font: { size: 10 }
                        },
                        grid: { color: 'rgba(255,255,255,0.05)' }
                    },
                    y: {
                        ticks: {
                            color: '#888',
                            font: { size: 10 },
                            callback: (v) => '$' + Number(v).toFixed(3)
                        },
                        grid: { color: 'rgba(255,255,255,0.05)' }
                    }
                }
            }
        });

        // Ako već ima istorije, prikaži je odmah
        if (history.length) {
            chart.update('none');
        }
    }

    // --- Javna funkcija koju poziva kripto.js ---
    function dodajTacku(vrednost) {
        if (typeof vrednost !== 'number' || !isFinite(vrednost)) return;

        const tacka = { t: Date.now(), v: vrednost };
        history.push(tacka);

        // Ograniči broj tačaka
        if (history.length > MAX_POINTS) {
            history = history.slice(history.length - MAX_POINTS);
        }
        sacuvajIstoriju();

        if (!chart) return;

        // Dodaj u Chart.js
        chart.data.labels.push(formatVreme(tacka.t));
        chart.data.datasets[0].data.push(tacka.v);

        // Skini višak sa početka ako je prekoračen limit
        while (chart.data.labels.length > MAX_POINTS) {
            chart.data.labels.shift();
            chart.data.datasets[0].data.shift();
        }

        chart.update();
    }

    // --- Init kada je DOM spreman ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initChart);
    } else {
        initChart();
    }

    // Izloži API globalno (kripto.js ga poziva)
    window.UkChart = { dodajTacku };
})();
