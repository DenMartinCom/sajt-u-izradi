// ===== GRAFIKON "Uk." vrednosti kroz vreme =====
// Vrednost dolazi iz gas widgeta (desno od "Uk.")
// Istorija se čuva u localStorage (samo kod ovog posetioca)

(function () {
    const STORAGE_KEY = 'uk_history_v1';
    const MAX_POINTS = 200;      // koliko poslednjih tačaka čuvamo
    const SMA_PERIOD = 10;       // period za SMA

    let chart = null;
    let history = [];
    let poslednjiYOpseg = null;

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

    // --- Formatiraj vreme: HH:MM ---
    function formatVreme(ts) {
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    }

    // --- Puno vreme za tooltip / min-max ---
    function formatPunoVreme(ts) {
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        return `${hh}:${mm}:${ss} ${dd}.${mo}.`;
    }

    // --- SMA ---
    function izracunajSMA(vrednosti, period) {
        const rezultat = [];
        for (let i = 0; i < vrednosti.length; i++) {
            if (i < period - 1) {
                rezultat.push(null);
                continue;
            }
            let suma = 0;
            for (let j = 0; j < period; j++) {
                suma += vrednosti[i - j];
            }
            rezultat.push(suma / period);
        }
        return rezultat;
    }

    // --- Min/Max tačke ---
    function nadjiMinMax() {
        if (!history.length) return { min: null, max: null };
        let min = history[0];
        let max = history[0];
        for (const p of history) {
            if (p.v < min.v) min = p;
            if (p.v > max.v) max = p;
        }
        return { min, max };
    }

    // --- Plugin: min/max anotacije ---
    const minMaxPlugin = {
        id: 'minMaxPlugin',
        afterDatasetsDraw(chart) {
            const { ctx, chartArea, scales } = chart;
            const mm = nadjiMinMax();
            if (!mm.min || !mm.max) return;
            if (!chartArea) return;

            const yScale = scales.y;
            const xScale = scales.x;

            function nacrtajAnotaciju(tacka, tip) {
                let idx = -1;
                for (let i = history.length - 1; i >= 0; i--) {
                    if (history[i].t === tacka.t && history[i].v === tacka.v) {
                        idx = i;
                        break;
                    }
                }
                if (idx < 0) return;

                const x = xScale.getPixelForValue(idx);
                const y = yScale.getPixelForValue(tacka.v);

                const boja = tip === 'max' ? '#f44336' : '#4caf50';
                const labela = (tip === 'max' ? 'MAX ' : 'MIN ') +
                    '$' + tacka.v.toFixed(2) + '  ' + formatPunoVreme(tacka.t);

                ctx.save();
                ctx.font = '10px system-ui, sans-serif';
                ctx.textBaseline = 'middle';

                ctx.beginPath();
                ctx.arc(x, y, 3.5, 0, Math.PI * 2);
                ctx.fillStyle = boja;
                ctx.fill();

                const textWidth = ctx.measureText(labela).width;
                let tx = x + 8;
                let align = 'left';
                if (tx + textWidth > chartArea.right) {
                    tx = x - 8;
                    align = 'right';
                }
                ctx.textAlign = align;
                ctx.fillStyle = boja;
                ctx.fillText(labela, tx, y);
                ctx.restore();
            }

            nacrtajAnotaciju(mm.max, 'max');
            nacrtajAnotaciju(mm.min, 'min');
        }
    };

    // --- Y tick-ovi: min, sredina, max ---
    function yTickValues(min, max) {
        if (min === null || max === null) return [];
        if (min === max) return [min];
        const mid = (min + max) / 2;
        return [min, mid, max];
    }

    // --- Da li osvežiti Y tick-ove? (samo ako se opseg značajno menja) ---
    function trebaRefreshY(nowMin, nowMax) {
        if (poslednjiYOpseg === null) {
            poslednjiYOpseg = { min: nowMin, max: nowMax };
            return true;
        }
        const stariOpseg = poslednjiYOpseg.max - poslednjiYOpseg.min;
        if (stariOpseg === 0) {
            if (nowMin !== poslednjiYOpseg.min || nowMax !== poslednjiYOpseg.max) {
                poslednjiYOpseg = { min: nowMin, max: nowMax };
                return true;
            }
            return false;
        }
        const promenaMin = Math.abs(nowMin - poslednjiYOpseg.min) / stariOpseg;
        const promenaMax = Math.abs(nowMax - poslednjiYOpseg.max) / stariOpseg;
        if (promenaMin > 0.01 || promenaMax > 0.01) {
            poslednjiYOpseg = { min: nowMin, max: nowMax };
            return true;
        }
        return false;
    }

    // --- Inicijalizacija ---
    function initChart() {
        const canvas = document.getElementById('uk-chart');
        if (!canvas || typeof Chart === 'undefined') return;

        history = ucitajIstoriju();

        const labels = history.map(p => formatVreme(p.t));
        const vrednosti = history.map(p => p.v);
        const sma = izracunajSMA(vrednosti, SMA_PERIOD);

        const mm = nadjiMinMax();
        const yTicks = yTickValues(mm.min ? mm.min.v : null, mm.max ? mm.max.v : null);

        chart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Uk. ($)',
                        data: vrednosti,
                        borderColor: '#FFD700',
                        backgroundColor: 'rgba(255, 215, 0, 0.12)',
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        pointBackgroundColor: '#FFD700',
                        tension: 0.35,
                        fill: true,
                        order: 1
                    },
                    {
                        label: 'SMA(' + SMA_PERIOD + ')',
                        data: sma,
                        borderColor: '#4fc3f7',
                        backgroundColor: 'transparent',
                        borderWidth: 1.6,
                        pointRadius: 0,
                        pointHoverRadius: 0,
                        tension: 0.35,
                        fill: false,
                        spanGaps: false,
                        order: 0
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 400 },
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                const i = items[0].dataIndex;
                                if (!history[i]) return '';
                                return formatPunoVreme(history[i].t);
                            },
                            label: (ctx) => {
                                const v = ctx.parsed.y;
                                if (v === null || v === undefined) return null;
                                if (ctx.datasetIndex === 0) return 'Uk.: $' + Number(v).toFixed(2);
                                return 'SMA: $' + Number(v).toFixed(2);
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            display: false,
                            drawBorder: true,
                            color: 'rgba(255,255,255,0.15)'
                        },
                        border: { color: 'rgba(255,255,255,0.15)' },
                        ticks: {
                            color: '#888',
                            maxRotation: 0,
                            autoSkip: false,
                            font: { size: 10 },
                            callback: function (value, index) {
                                const total = this.chart.data.labels.length;
                                if (total === 0) return '';
                                if (total === 1) return this.chart.data.labels[0];
                                if (total === 2) {
                                    // samo prva i poslednja
                                    if (index === 0) return this.chart.data.labels[0];
                                    if (index === 1) return this.chart.data.labels[1];
                                    return '';
                                }
                                // 3 labele: prva, srednja, poslednja
                                const mid = Math.floor((total - 1) / 2);
                                if (index === 0) return this.chart.data.labels[0];
                                if (index === mid) return this.chart.data.labels[mid];
                                if (index === total - 1) return this.chart.data.labels[total - 1];
                                return '';
                            }
                        }
                    },
                    y: {
                        grid: {
                            display: false,
                            drawBorder: true,
                            color: 'rgba(255,255,255,0.15)'
                        },
                        border: { color: 'rgba(255,255,255,0.15)' },
                        min: mm.min ? mm.min.v : undefined,
                        max: mm.max ? mm.max.v : undefined,
                        ticks: {
                            color: '#888',
                            font: { size: 10 },
                            autoSkip: false,
                            callback: function (value) {
                                // Prikazujemo samo vrednosti koje su u našem nizu
                                // (min, sredina, max) — ostale sklanjamo.
                                for (const t of yTicks) {
                                    if (Math.abs(value - t) < 1e-9) {
                                        return Number(value).toFixed(2);
                                    }
                                }
                                return '';
                            }
                        },
                        afterBuildTicks: (axis) => {
                            // Nateraj Chart.js da generiše tačno 3 tick-a.
                            axis.ticks = yTicks.map(v => ({ value: v }));
                        }
                    }
                }
            },
            plugins: [minMaxPlugin]
        });

        if (history.length) chart.update('none');
    }

    // --- Dodavanje tačke ---
    function dodajTacku(vrednost) {
        if (typeof vrednost !== 'number' || !isFinite(vrednost)) return;

        const tacka = { t: Date.now(), v: vrednost };
        history.push(tacka);
        if (history.length > MAX_POINTS) {
            history = history.slice(history.length - MAX_POINTS);
        }
        sacuvajIstoriju();

        if (!chart) return;

        chart.data.labels.push(formatVreme(tacka.t));
        chart.data.datasets[0].data.push(tacka.v);

        while (chart.data.labels.length > MAX_POINTS) {
            chart.data.labels.shift();
            chart.data.datasets[0].data.shift();
        }

        chart.data.datasets[1].data = izracunajSMA(chart.data.datasets[0].data, SMA_PERIOD);

        // Y osa: osveži samo ako se opseg značajno menja
        const mm = nadjiMinMax();
        if (mm.min && mm.max && trebaRefreshY(mm.min.v, mm.max.v)) {
            const yTicks = yTickValues(mm.min.v, mm.max.v);
            chart.options.scales.y.min = mm.min.v;
            chart.options.scales.y.max = mm.max.v;
            chart.options.scales.y.afterBuildTicks = (axis) => {
                axis.ticks = yTicks.map(v => ({ value: v }));
            };
        }

        chart.update();
    }

    // --- Reset ---
    function resetIstorije() {
        if (!confirm('Obrisati celu istoriju grafikona?')) return;
        history = [];
        poslednjiYOpseg = null;
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        if (chart) {
            chart.data.labels = [];
            chart.data.datasets[0].data = [];
            chart.data.datasets[1].data = [];
            chart.update();
        }
    }

    // --- R dugme ---
    function dodajResetDugme() {
        const wrap = document.querySelector('.grafikon-wrap');
        if (!wrap || document.getElementById('grafikon-reset')) return;
        const btn = document.createElement('button');
        btn.id = 'grafikon-reset';
        btn.type = 'button';
        btn.title = 'Reset istorije';
        btn.textContent = 'R';
        btn.addEventListener('click', resetIstorije);
        wrap.appendChild(btn);
    }

    // --- Start ---
    function start() {
        initChart();
        dodajResetDugme();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    window.UkChart = { dodajTacku };
})();
