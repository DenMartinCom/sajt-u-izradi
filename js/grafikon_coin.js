// ===== GRAFIKON COINA =====
// Prikazuje istoriju cene (linija) i volumena (stubići) za izabrani token.
// Tokeni: iz /marquee (gornji red = set1 + fiksni).
// Periodi: 30..210 dana, Sve.
// Podaci: /istorija?token=X&dana=Y (keš u D1, 6h TTL).
(function () {
    const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
    const canvas = document.getElementById('coin-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    const headerEl = document.querySelector('.grafikon-coin-header');
    const selectTokenEl = document.getElementById('grafikon-coin-select');
    const statusEl = document.getElementById('grafikon-coin-status');
    if (!headerEl || !selectTokenEl) return;

    const PERIODI = [
        { v: '30',  t: '30 dana' },
        { v: '60',  t: '60 dana' },
        { v: '90',  t: '90 dana' },
        { v: '120', t: '120 dana' },
        { v: '150', t: '150 dana' },
        { v: '180', t: '180 dana' },
        { v: '210', t: '210 dana' },
        { v: 'sve', t: 'Sve' }
    ];

    let period = '30';
    let trenutniToken = null;
    let chart = null;
    let prikazVolumena = false;
    const kes = {}; // { "btc|30": { podaci } }

    // ===== DODAVANJE KONTROLA U HEADER =====
    function dodajKontrole() {
        const periodSelect = document.createElement('select');
        periodSelect.className = 'grafikon-coin-select';
        periodSelect.id = 'grafikon-coin-period';
        periodSelect.innerHTML = PERIODI.map(p =>
            `<option value="${p.v}"${p.v === period ? ' selected' : ''}>${p.t}</option>`
        ).join('');
        headerEl.appendChild(periodSelect);

        const volLabel = document.createElement('label');
        volLabel.className = 'grafikon-coin-vol';
        volLabel.innerHTML = `<input type="checkbox" id="coin-vol-cb"><span>Vol</span>`;
        headerEl.appendChild(volLabel);
    }

    // ===== POMOĆNE =====
    function formatDatum(d) {
        if (!d || typeof d !== 'string') return '';
        const delovi = d.split('-');
        if (delovi.length < 3) return d;
        return delovi[2] + '.' + delovi[1];
    }

    function formatCenaTick(v) {
        if (v >= 1000) return '$' + Math.round(v).toLocaleString('en-US');
        if (v >= 1) return '$' + v.toFixed(2);
        if (v >= 0.01) return '$' + v.toFixed(4);
        return '$' + v.toFixed(6);
    }

    function formatVolTick(v) {
        if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
        if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
        return String(v);
    }

    function obrisiGraf() {
        if (chart) { chart.destroy(); chart = null; }
    }

    // ===== CRTANJE =====
    function nacrtajGraf(podaci, simbol) {
        obrisiGraf();

        if (!podaci || !podaci.length) {
            if (statusEl) statusEl.textContent = 'Nema podataka';
            return;
        }

        const labels = podaci.map(p => formatDatum(p.d));
        const cene = podaci.map(p => p.c);
        const volumi = podaci.map(p => p.v || 0);

        const datasets = [{
            label: simbol.toUpperCase() + ' ($)',
            data: cene,
            borderColor: '#FFD700',
            backgroundColor: 'rgba(255,215,0,0.10)',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointBackgroundColor: '#FFD700',
            tension: 0.3,
            fill: true,
            yAxisID: 'y',
            order: 1
        }];

        if (prikazVolumena) {
            datasets.push({
                label: 'Volumen',
                data: volumi,
                type: 'bar',
                backgroundColor: 'rgba(136,136,136,0.35)',
                borderColor: 'rgba(136,136,136,0.5)',
                borderWidth: 0,
                yAxisID: 'y1',
                order: 2
            });
        }

        const scales = {
            x: {
                grid: { display: false },
                ticks: {
                    color: '#888',
                    font: { size: 10 },
                    maxRotation: 0,
                    autoSkip: true,
                    maxTicksLimit: 6
                }
            },
            y: {
                position: 'left',
                grid: { display: false },
                ticks: {
                    color: '#FFD700',
                    font: { size: 10 },
                    callback: formatCenaTick
                }
            }
        };

        if (prikazVolumena) {
            scales.y1 = {
                position: 'right',
                grid: { display: false },
                ticks: {
                    color: '#888',
                    font: { size: 10 },
                    callback: formatVolTick
                }
            };
        }

        chart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 300 },
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                const i = items[0].dataIndex;
                                return (podaci[i] && podaci[i].d) ? podaci[i].d : '';
                            },
                            label: (ctx) => {
                                const v = ctx.parsed.y;
                                if (v == null) return null;
                                if (ctx.datasetIndex === 0) {
                                    return 'Cena: $' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 6 });
                                }
                                return 'Volumen: ' + Number(v).toLocaleString('en-US');
                            }
                        }
                    }
                },
                scales
            }
        });

        if (statusEl) statusEl.textContent = simbol.toUpperCase() + ' • ' + podaci.length + ' dana';
    }

    // ===== UČITAVANJE =====
    async function ucitajToken(token) {
        if (!token) return;
        trenutniToken = token;
        const kljuc = token + '|' + period;

        if (kes[kljuc]) {
            nacrtajGraf(kes[kljuc].podaci, token);
            return;
        }

        if (statusEl) statusEl.textContent = 'Učitavanje...';

        try {
            const r = await fetch(`${WORKER_URL}/istorija?token=${encodeURIComponent(token)}&dana=${period}`);
            const d = await r.json();
            if (d.error) {
                if (statusEl) statusEl.textContent = 'Greška: ' + d.error;
                return;
            }
            const podaci = d.podaci || [];
            kes[kljuc] = { podaci };
            nacrtajGraf(podaci, token);
        } catch (e) {
            console.warn('Grafikon coin greška:', e);
            if (statusEl) statusEl.textContent = 'Greška pri učitavanju';
        }
    }

    // ===== DROPDOWN TOKENA =====
    async function napuniDropdown() {
        try {
            const r = await fetch(`${WORKER_URL}/marquee`);
            const d = await r.json();
            if (!d || d.error) {
                selectTokenEl.innerHTML = '<option value="">Greška</option>';
                return;
            }
            const gornji = [...(d.set1 || []), ...(d.fiksni || [])];
            const vidjeni = new Set();
            const lista = [];
            for (const c of gornji) {
                if (!c || !c.simbol || vidjeni.has(c.simbol)) continue;
                vidjeni.add(c.simbol);
                lista.push(c);
            }
            if (!lista.length) {
                selectTokenEl.innerHTML = '<option value="">Nema tokena</option>';
                return;
            }
            selectTokenEl.innerHTML = lista.map(c =>
                `<option value="${c.simbol}">${c.simbol.toUpperCase()} — ${c.naziv}</option>`
            ).join('');
            ucitajToken(lista[0].simbol);
        } catch (e) {
            console.warn('Dropdown greška:', e);
            selectTokenEl.innerHTML = '<option value="">Greška</option>';
        }
    }

    // ===== INIT =====
    dodajKontrole();

    const periodEl = document.getElementById('grafikon-coin-period');
    const volCb = document.getElementById('coin-vol-cb');

    if (periodEl) {
        periodEl.addEventListener('change', () => {
            period = periodEl.value;
            if (trenutniToken) ucitajToken(trenutniToken);
        });
    }

    if (volCb) {
        volCb.addEventListener('change', () => {
            prikazVolumena = volCb.checked;
            if (trenutniToken) {
                const kljuc = trenutniToken + '|' + period;
                if (kes[kljuc]) nacrtajGraf(kes[kljuc].podaci, trenutniToken);
            }
        });
    }

    if (selectTokenEl) {
        selectTokenEl.addEventListener('change', () => {
            ucitajToken(selectTokenEl.value);
        });
    }

    napuniDropdown();
})();