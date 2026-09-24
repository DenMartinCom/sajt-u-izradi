// ===== VOLUMEN — promena volumena trgovanja =====
// Prikazuje top 10 tokena po promeni volumena (gainers/losers)
// Za izabrani period. Izvor: /volumen (kripto_kes tabela).
(function () {
    const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
    const el = document.getElementById('volumen-widget');
    if (!el) return;

    let period = '24h';

    // Svi periodi — dropdown
    // (ostali su tu radi budućnosti, trenutno samo 24h ima podatke)
    const PERIODI = [
        { v: '1h',  t: '1h' },
        { v: '6h',  t: '6h' },
        { v: '12h', t: '12h' },
        { v: '24h', t: '24h' },
        { v: '7d',  t: '7d' },
        { v: '14d', t: '14d' },
        { v: '30d', t: '30d' },
        { v: '60d', t: '60d' },
        { v: '90d', t: '90d' }
    ];

    function formatPromena(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '';
        const znak = n >= 0 ? '+' : '';
        const abs = Math.abs(n);
        if (abs >= 1000) return znak + Math.round(abs).toLocaleString('en-US') + '%';
        return znak + Math.round(abs) + '%';
    }

    function cmcUrl(c) {
        const slug = c.cmc_slug || c.simbol;
        return 'https://coinmarketcap.com/currencies/' + encodeURIComponent(slug) + '/';
    }

    function red(c) {
        const kl = c.promena >= 0 ? 'up' : 'down';
        return `<a class="liste-red" href="${cmcUrl(c)}" target="_blank" rel="noopener">
            <img src="${c.logo}" alt="${c.simbol}" loading="lazy" onerror="if(!this.dataset.err){this.dataset.err=1; this.src='Slike/coins/_default.png';}">
            <span class="lr-simbol">${c.simbol}</span>
            <span class="lr-promena ${kl}">${formatPromena(c.promena)}</span>
        </a>`;
    }

    function skeleton() {
        const opcije = PERIODI.map(p =>
            `<option value="${p.v}"${p.v === period ? ' selected' : ''}>${p.t}</option>`
        ).join('');
        el.innerHTML = `
            <div class="liste-header">
                <div class="liste-title">Promena volumena</div>
                <select class="liste-period" id="volumen-period">${opcije}</select>
            </div>
            <div class="liste-kolone">
                <div>
                    <div class="liste-podnaslov">Rast volumena</div>
                    <div id="volumen-gainers"><div class="liste-loading">Učitavanje...</div></div>
                </div>
                <div>
                    <div class="liste-podnaslov losers">Pad volumena</div>
                    <div id="volumen-losers"><div class="liste-loading">Učitavanje...</div></div>
                </div>
            </div>
        `;
    }

    async function ucitaj() {
        const gEl = document.getElementById('volumen-gainers');
        const lEl = document.getElementById('volumen-losers');
        if (!gEl || !lEl) return;

        gEl.innerHTML = '<div class="liste-loading">Učitavanje...</div>';
        lEl.innerHTML = '<div class="liste-loading">Učitavanje...</div>';

        try {
            const r = await fetch(`${WORKER_URL}/volumen?period=${period}&limit=10`);
            const d = await r.json();

            if (d && Array.isArray(d.gainers) && d.gainers.length) {
                gEl.innerHTML = d.gainers.map(red).join('');
            } else {
                gEl.innerHTML = '<div class="liste-loading">Nema podataka</div>';
            }

            if (d && Array.isArray(d.losers) && d.losers.length) {
                lEl.innerHTML = d.losers.map(red).join('');
            } else {
                lEl.innerHTML = '<div class="liste-loading">Nema podataka</div>';
            }
        } catch (e) {
            console.warn('Volumen greška:', e);
            gEl.innerHTML = '<div class="liste-loading">Greška</div>';
            lEl.innerHTML = '<div class="liste-loading">Greška</div>';
        }
    }

    skeleton();

    const sel = document.getElementById('volumen-period');
    if (sel) {
        sel.addEventListener('change', () => {
            period = sel.value;
            ucitaj();
        });
    }

    ucitaj();
    setInterval(ucitaj, 60000);
})();