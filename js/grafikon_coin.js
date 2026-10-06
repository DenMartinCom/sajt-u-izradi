// ===== GRAFIKON COINA =====
// Prikazuje istoriju cene (linija) i volumena (stubići) za izabrani token.
// Tokeni: iz /marquee (gornji red = set1 + fiksni) — producer.
// Podaci: /graf/{cmc_id}.json (R2, dnevni snapshoti, keš 24h) — consumer.
(function () {
    const PRODUCER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
    const CONSUMER_URL = 'https://kripto-consumer.martin-denic.workers.dev';
    const canvas = document.getElementById('coin-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    const headerEl = document.querySelector('.grafikon-coin-header');
    if (!headerEl) return;

    const PERIODI = [
        { v: '30',  t: '30d' },
        { v: '60',  t: '60d' },
        { v: '90',  t: '90d' },
        { v: '120', t: '120d' },
        { v: '150', t: '150d' },
        { v: '180', t: '180d' },
        { v: '210', t: '210d' },
        { v: 'sve', t: 'Sve' }
    ];

    let period = '30';
    let trenutniCmcId = null;
    let trenutniSimbol = null;
    let chart = null;
    let prikazVolumena = false;
    const kes = {}; // { "cmcId|period": { podaci, simbol } }

    // ===== DODAVANJE KONTROLA U HEADER =====
    function dodajKontrole() {
        // Token dropdown
        const tokenCd = document.createElement('div');
        tokenCd.className = 'cd cd-token';
        tokenCd.id = 'coin-token-cd';
        tokenCd.innerHTML = `
            <button class="cd-toggle" type="button">Učitavanje...</button>
            <div class="cd-menu"></div>
        `;
        headerEl.appendChild(tokenCd);

        // Period dropdown
        const periodCd = document.createElement('div');
        periodCd.className = 'cd';
        periodCd.id = 'coin-period-cd';
        const opcije = PERIODI.map(p =>
            `<div class="cd-item${p.v === period ? ' active' : ''}" data-value="${p.v}">${p.t}</div>`
        ).join('');
        periodCd.innerHTML = `
            <button class="cd-toggle" type="button">${PERIODI.find(p => p.v === period).t}</button>
            <div class="cd-menu">${opcije}</div>
        `;
        headerEl.appendChild(periodCd);

        // Vol checkbox
        const volLabel = document.createElement('label');
        volLabel.className = 'grafikon-coin-vol';
        volLabel.innerHTML = `<input type="checkbox" id="coin-vol-cb"><span>Vol</span>`;
        headerEl.appendChild(volLabel);
    }

    // ===== POMOĆNE =====
    function formatDatum(ms) {
        if (ms == null) return '';
        const d = new Date(Number(ms));
        if (!isFinite(d.getTime())) return '';
        const dan = String(d.getDate()).padStart(2, '0');
        const mes = String(d.getMonth() + 1).padStart(2, '0');
        return dan + '.' + mes + '.';
    }

    function obrisiGraf() {
        if (chart) { chart.destroy(); chart = null; }
    }

    function filtrirajPoPeriodu(podaci, periodStr) {
        if (!Array.isArray(podaci) || !podaci.length) return [];
        if (periodStr === 'sve') return podaci.slice();
        const dana = parseInt(periodStr, 10);
        if (!isFinite(dana) || dana <= 0) return podaci.slice();
        const granica = Date.now() - dana * 86400000;
        return podaci.filter(p => Number(p.d) >= granica);
    }

    // ===== CRTANJE =====
    function nacrtajGraf(podaci, simbol) {
        obrisiGraf();

        if (!podaci || !podaci.length) {
            const statusEl = document.getElementById('grafikon-coin-status');
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
                    maxTicksLimit: 3,
                    callback: (v) => window.formatCena(v)
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
                    maxTicksLimit: 3,
                    callback: (v) => window.formatCena(v)
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
                events: ['click', 'touchstart'],
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                const i = items[0].dataIndex;
                                if (!podaci[i]) return '';
                                const d = new Date(Number(podaci[i].d));
                                if (!isFinite(d.getTime())) return '';
                                const dan = String(d.getDate()).padStart(2, '0');
                                const mes = String(d.getMonth() + 1).padStart(2, '0');
                                const god = d.getFullYear();
                                return `${dan}.${mes}.${god}.`;
                            },
                            label: (ctx) => {
                                const v = ctx.parsed.y;
                                if (v == null) return null;
                                if (ctx.datasetIndex === 0) {
                                    return 'Cena: $' + window.formatCena(v);
                                }
                                return 'Volumen: ' + window.formatCena(v);
                            }
                        }
                    }
                },
                scales
            }
        });

        const statusEl = document.getElementById('grafikon-coin-status');
        if (statusEl) statusEl.textContent = simbol.toUpperCase() + ' • ' + podaci.length + ' dana';
    }

    // ===== UČITAVANJE =====
    async function ucitajToken(cmcId, simbol) {
        if (!cmcId) return;
        trenutniCmcId = cmcId;
        trenutniSimbol = simbol;
        const kljuc = cmcId + '|' + period;

        if (kes[kljuc]) {
            const filtrirano = filtrirajPoPeriodu(kes[kljuc].podaci, period);
            nacrtajGraf(filtrirano, kes[kljuc].simbol);
            return;
        }

        const statusEl = document.getElementById('grafikon-coin-status');
        if (statusEl) statusEl.textContent = 'Učitavanje...';

        try {
            const r = await fetch(`${CONSUMER_URL}/graf/${encodeURIComponent(cmcId)}.json`);
            if (r.status === 404) {
                if (statusEl) statusEl.textContent = 'Nema grafa za ' + String(simbol).toUpperCase();
                return;
            }
            const d = await r.json();
            if (!d || !Array.isArray(d.podaci)) {
                if (statusEl) statusEl.textContent = 'Nema podataka';
                return;
            }
            const sim = d.simbol || simbol;
            kes[cmcId + '|sve'] = { podaci: d.podaci, simbol: sim };
            // keširaj i po periodu da ne ponavlja filter
            kes[kljuc] = { podaci: d.podaci, simbol: sim };
            const filtrirano = filtrirajPoPeriodu(d.podaci, period);
            nacrtajGraf(filtrirano, sim);
        } catch (e) {
            console.warn('Grafikon coin greška:', e);
            if (statusEl) statusEl.textContent = 'Greška pri učitavanju';
        }
    }

    // ===== DROPDOWN TOKENA =====
    async function napuniTokenDropdown() {
        const cd = document.getElementById('coin-token-cd');
        if (!cd) return;
        const toggle = cd.querySelector('.cd-toggle');
        const menu = cd.querySelector('.cd-menu');

        try {
            const r = await fetch(`${PRODUCER_URL}/marquee`);
            const d = await r.json();
            if (!d || d.error) {
                menu.innerHTML = '<div class="cd-item">Greška</div>';
                toggle.textContent = 'Greška';
                return;
            }
            const gornji = [...(d.set1 || []), ...(d.fiksni || [])];
            const vidjeni = new Set();
            const lista = [];
            for (const c of gornji) {
                if (!c || !c.simbol || c.cmc_id == null) continue;
                if (vidjeni.has(String(c.cmc_id))) continue;
                vidjeni.add(String(c.cmc_id));
                lista.push(c);
            }
            if (!lista.length) {
                menu.innerHTML = '<div class="cd-item">Nema tokena</div>';
                toggle.textContent = 'Nema tokena';
                return;
            }

            menu.innerHTML = lista.map(c =>
                `<div class="cd-item" data-cmc="${c.cmc_id}" data-simbol="${c.simbol}">${c.simbol.toUpperCase()} — ${c.naziv}</div>`
            ).join('');

            toggle.textContent = lista[0].simbol.toUpperCase();
            menu.querySelector('.cd-item').classList.add('active');

            // Klik na stavku
            menu.addEventListener('click', (e) => {
                const item = e.target.closest('.cd-item');
                if (!item) return;
                const cmcId = item.dataset.cmc;
                const simbol = item.dataset.simbol;
                toggle.textContent = simbol.toUpperCase();
                menu.querySelectorAll('.cd-item').forEach(x => x.classList.toggle('active', x.dataset.cmc === cmcId));
                cd.classList.remove('open');
                ucitajToken(cmcId, simbol);
            });

            // Toggle
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const bioOtvoren = cd.classList.contains('open');
                cd.classList.toggle('open');
                if (!bioOtvoren) {
                    const active = menu.querySelector('.cd-item.active');
                    if (active) active.scrollIntoView({ block: 'nearest' });
                }
            });
            document.addEventListener('click', () => cd.classList.remove('open'));

            ucitajToken(lista[0].cmc_id, lista[0].simbol);
        } catch (e) {
            console.warn('Dropdown greška:', e);
            menu.innerHTML = '<div class="cd-item">Greška</div>';
            toggle.textContent = 'Greška';
        }
    }

    // ===== INIT =====
    dodajKontrole();

    const periodCd = document.getElementById('coin-period-cd');
    const periodToggle = periodCd.querySelector('.cd-toggle');
    const periodMenu = periodCd.querySelector('.cd-menu');
    periodToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const bioOtvoren = periodCd.classList.contains('open');
        periodCd.classList.toggle('open');
        if (!bioOtvoren) {
            const active = periodMenu.querySelector('.cd-item.active');
            if (active) active.scrollIntoView({ block: 'nearest' });
        }
    });
    periodMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.cd-item');
        if (!item) return;
        const val = item.dataset.value;
        period = val;
        periodToggle.textContent = item.textContent;
        periodMenu.querySelectorAll('.cd-item').forEach(x => x.classList.toggle('active', x.dataset.value === val));
        periodCd.classList.remove('open');
        if (trenutniCmcId) ucitajToken(trenutniCmcId, trenutniSimbol);
    });
    document.addEventListener('click', () => periodCd.classList.remove('open'));

    const volCb = document.getElementById('coin-vol-cb');
    if (volCb) {
        volCb.addEventListener('change', () => {
            prikazVolumena = volCb.checked;
            if (trenutniCmcId) {
                const kljuc = trenutniCmcId + '|' + period;
                if (kes[kljuc]) {
                    const filtrirano = filtrirajPoPeriodu(kes[kljuc].podaci, period);
                    nacrtajGraf(filtrirano, kes[kljuc].simbol);
                }
            }
        });
    }

    napuniTokenDropdown();
})();