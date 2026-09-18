// ===== GRAFIKON "Uk." vrednosti kroz vreme =====
// Vrednost dolazi iz gas widgeta (desno od "Uk.")
// Istorija se čuva u localStorage (samo kod ovog posetioca)

(function () {
    const STORAGE_KEY = 'uk_history_v1';
    const MAX_POINTS = 200;
    const SMA_PERIOD = 10;

    let chart = null;
    let history = [];
    let poslednjiYOpseg = null;

    // --- Učitaj istoriju ---
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

    function sacuvajIstoriju() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
        } catch (e) {
            console.warn('Grafikon: ne mogu da sačuvam istoriju:', e);
        }
    }

    function formatVreme(ts) {
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    }

    function formatPunoVreme(ts) {
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        return `${hh}:${mm}:${ss} ${dd}.${mo}.`;
    }

    function izracunajSMA(vrednosti, period) {
        const rezultat = [];
        for (let i = 0; i < vrednosti.length; i++) {
            if (i < period - 1) {
                rezultat.push(null);
                continue;
            }
            let suma = 0;
            for (let j = 0; j < period; j++) suma += vrednosti[i - j];
            rezultat.push(suma / period);
        }
        return rezultat;
    }

    function nadjiMinMax() {
        if (!history.length) return { min: null, max: null };
        let min = history[0], max = history[0];
        for (const p of history) {
            if (p.v < min.v) min = p;
            if (p.v > max.v) max = p;
        }
        return { min, max };
    }

    // ===== "LEPO" ZAOKRUŽIVANJE =====
    // Na osnovu veličine broja bira se korak (step) i zaokružuje se
    // na tu vrednost: nadole za min, nagore za max.
    function izaberiKorak(vrednost) {
        const aps = Math.abs(vrednost);
        if (aps === 0) return 0.01;
        // red veličine: 10^k gde je k floor(log10(aps))
        const k = Math.floor(Math.log10(aps));
        // korak = 10^k (npr. 0.01, 0.1, 1, 10...)
        return Math.pow(10, k);
    }

    function zaokruziDole(v, korak) {
        return Math.floor(v / korak) * korak;
    }
    function zaokruziGore(v, korak) {
        return Math.ceil(v / korak) * korak;
    }

    // Koliko decimala prikazati za dati korak
    // Uvek 2 decimale za Y labele (želimo "viši" graf)
function decimaleZaKorak(korak) {
    return 2;
}

    // Vraća 3 Y tick vrednosti: [donja, srednja (prosek), gornja]
    function yTickValues(minV, maxV) {
        if (minV === null || maxV === null) return [];
        if (minV === maxV) return [minV];

        // Korak na osnovu najveće apsolutne vrednosti opsega
        const refVrednost = Math.max(Math.abs(minV), Math.abs(maxV));
        const korak = izaberiKorak(refVrednost);

        const donja = zaokruziDole(minV, korak);
        const gornja = zaokruziGore(maxV, korak);
        const srednja = (donja + gornja) / 2;

        return [donja, srednja, gornja];
    }

    function formatYLabel(v, korak) {
        const dec = decimaleZaKorak(korak);
        return Number(v).toFixed(dec);
    }

    // --- Plugin: min/max anotacije ---
    const minMaxPlugin = {
        id: 'minMaxPlugin',
        afterDatasetsDraw(chart) {
            const { ctx, chartArea, scales } = chart;
            const mm = nadjiMinMax();
            if (!mm.min || !mm.max || !chartArea) return;

            const yScale = scales.y;
            const xScale = scales.x;

            function nacrtaj(tacka, tip) {
                let idx = -1;
                for (let i = history.length - 1; i >= 0; i--) {
                    if (history[i].t === tacka.t && history[i].v === tacka.v) {
                        idx = i; break;
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

                const tw = ctx.measureText(labela).width;
                let tx = x + 8, align = 'left';
                if (tx + tw > chartArea.right) { tx = x - 8; align = 'right'; }
                ctx.textAlign = align;
                ctx.fillStyle = boja;
                ctx.fillText(labela, tx, y);
                ctx.restore();
            }

            nacrtaj(mm.max, 'max');
            nacrtaj(mm.min, 'min');
        }
    };

    // --- Da li osvežiti Y tick-ove? ---
    // Osvežavamo samo kad se min ili max pomeri van trenutnog opsega
    // (tj. kad nova tačka probije donju/gornju zaokruženu granicu).
    function trebaRefreshY(nowMin, nowMax) {
        if (poslednjiYOpseg === null) {
            poslednjiYOpseg = { min: nowMin, max: nowMax };
            return true;
        }
        // Ako je nova vrednost van već prikazanog opsega — osveži
        if (nowMin < poslednjiYOpseg.min || nowMax > poslednjiYOpseg.max) {
            poslednjiYOpseg = { min: nowMin, max: nowMax };
            return true;
        }
        return false;
    }

    // --- Init ---
    function initChart() {
        const canvas = document.getElementById('uk-chart');
        if (!canvas || typeof Chart === 'undefined') return;

        history = ucitajIstoriju();

        const labels = history.map(p => formatVreme(p.t));
        const vrednosti = history.map(p => p.v);
        const sma = izracunajSMA(vrednosti, SMA_PERIOD);

        const mm = nadjiMinMax();
        const yTicks = yTickValues(mm.min ? mm.min.v : null, mm.max ? mm.max.v : null);
        const refV = Math.max(Math.abs(mm.min ? mm.min.v : 0), Math.abs(mm.max ? mm.max.v : 0));
        const korak = izaberiKorak(refV);
        const dec = decimaleZaKorak(korak);

        // Postavi min/max skale na zaokružene vrednosti (donja/gornja iz yTicks)
        const yMin = yTicks.length ? yTicks[0] : undefined;
        const yMax = yTicks.length ? yTicks[yTicks.length - 1] : undefined;

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
                        grid: { display: false, drawBorder: true, color: 'rgba(255,255,255,0.15)' },
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
                                    if (index === 0) return this.chart.data.labels[0];
                                    if (index === 1) return this.chart.data.labels[1];
                                    return '';
                                }
                                const mid = Math.floor((total - 1) / 2);
                                if (index === 0) return this.chart.data.labels[0];
                                if (index === mid) return this.chart.data.labels[mid];
                                if (index === total - 1) return this.chart.data.labels[total - 1];
                                return '';
                            }
                        }
                    },
                    y: {
                        grid: { display: false, drawBorder: true, color: 'rgba(255,255,255,0.15)' },
                        border: { color: 'rgba(255,255,255,0.15)' },
                        min: yMin,
                        max: yMax,
                        ticks: {
                            color: '#888',
                            font: { size: 10 },
                            autoSkip: false,
                            callback: function (value) {
                                for (const t of yTicks) {
                                    if (Math.abs(value - t) < 1e-9) {
                                        return formatYLabel(value, korak);
                                    }
                                }
                                return '';
                            }
                        },
                        afterBuildTicks: (axis) => {
                            axis.ticks = yTicks.map(v => ({ value: v }));
                        }
                    }
                }
            },
            plugins: [minMaxPlugin]
        });

        if (history.length) chart.update('none');
    }

    // --- Dodaj tačku ---
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

        // Y osa: osveži samo kad nova vrednost probije trenutni opseg
        const mm = nadjiMinMax();
        if (mm.min && mm.max) {
            const trenutniMin = chart.options.scales.y.min;
            const trenutniMax = chart.options.scales.y.max;
            const probija = (trenutniMin === undefined || trenutniMax === undefined)
                || (mm.min.v < trenutniMin)
                || (mm.max.v > trenutniMax);

            if (probija) {
                const yTicks = yTickValues(mm.min.v, mm.max.v);
                const refV = Math.max(Math.abs(mm.min.v), Math.abs(mm.max.v));
                const korak = izaberiKorak(refV);

                chart.options.scales.y.min = yTicks[0];
                chart.options.scales.y.max = yTicks[yTicks.length - 1];
                chart.options.scales.y.afterBuildTicks = (axis) => {
                    axis.ticks = yTicks.map(v => ({ value: v }));
                };
                chart.options.scales.y.ticks.callback = function (value) {
                    for (const t of yTicks) {
                        if (Math.abs(value - t) < 1e-9) {
                            return formatYLabel(value, korak);
                        }
                    }
                    return '';
                };
                poslednjiYOpseg = { min: mm.min.v, max: mm.max.v };
            }
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
