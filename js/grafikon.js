// ===== GRAFIKON "Uk." vrednosti kroz vreme =====
// Vrednost dolazi iz gas widgeta (desno od "Uk.")
// Istorija se čuva u localStorage (samo kod ovog posetioca)

(function () {
    const STORAGE_KEY = 'uk_history_v1';
    const MAX_POINTS = 200;      // koliko poslednjih tačaka čuvamo
    const MAX_X_TICKS = 8;       // početno vreme + još max 7
    const SMA_PERIOD = 10;       // period za SMA

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

    // --- Formatiraj vreme: HH:MM (bez sekundi) ---
    function formatVreme(ts) {
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    }

    // --- Puno vreme za tooltip / min-max: HH:MM:SS DD.MM. ---
    function formatPunoVreme(ts) {
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        return `${hh}:${mm}:${ss} ${dd}.${mo}.`;
    }

    // --- Izračunaj SMA za niz vrednosti ---
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

    // --- Nađi min i max tačke ---
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

    // --- Plugin: crta min i max anotacije ---
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

                const boja = tip === 'max' ? '#4caf50' : '#f44336';
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

    // --- Inicijalizacija Chart.js ---
    function initChart() {
        const canvas = document.getElementById('uk-chart');
        if (!canvas || typeof Chart === 'undefined') return;

        history = ucitajIstoriju();

        const labels = history.map(p => formatVreme(p.t));
        const vrednosti = history.map(p => p.v);
        const sma = izracunajSMA(vrednosti, SMA_PERIOD);

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
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: { display: false },
