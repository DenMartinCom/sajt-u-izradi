// ===== LISTE (gainers/losers) =====
(function () {
    const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
    const el = document.getElementById('liste-widget');
    if (!el) return;

    let period = '24h';

    function formatCena(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '—';
        if (n >= 100) return '$' + Math.round(n).toLocaleString('en-US');
        if (n >= 1) return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (n >= 0.01) return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
        return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
    }

    function formatPromena(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '';
        const znak = n >= 0 ? '+' : '';
        return znak + n.toFixed(2) + '%';
    }

    function cmcUrl(simbol) {
        return 'https://coinmarketcap.com/currencies/' + encodeURIComponent(simbol) + '/';
    }

    function red(c) {
        const kl = c.promena >= 0 ? 'up' : 'down';
        return `<a class="liste-red" href="${cmcUrl(c.simbol)}" target="_blank" rel="noopener">
            <img src="${c.logo}" alt="${c.simbol}" onerror="this.src='Slike/coins/_default.png'">
            <span class="lr-simbol">${c.simbol}</span>
            <span class="lr-cena">${formatCena(c.cena)}</span>
            <span class="lr-promena ${kl}">${formatPromena(c.promena)}</span>
        </a>`;
    }

    function skeleton() {
        el.innerHTML = `
            <div class="liste-header">
                <div class="liste-title">Top 5 promena</div>
                <select class="liste-period" id="liste-period">
                    <option value="1h">1h</option>
                    <option value="24h" selected>24h</option>
                    <option value="7d">7d</option>
                    <option value="30d">30d</option>
                    <option value="60d">60d</option>
                    <option value="90d">90d</option>
                </select>
            </div>
            <div class="liste-kolone">
                <div>
                    <div class="liste-podnaslov">Rast</div>
                    <div id="liste-gainers"><div class="liste-loading">Učitavanje...</div></div>
                </div>
                <div>
                    <div class="liste-podnaslov losers">Pad</div>
                    <div id="liste-losers"><div class="liste-loading">Učitavanje...</div></div>
                </div>
            </div>
        `;
    }

    async function ucitaj() {
        const gEl = document.getElementById('liste-gainers');
        const lEl = document.getElementById('liste-losers');
        if (!gEl || !lEl) return;

        try {
            const [rg, rl] = await Promise.all([
                fetch(`${WORKER_URL}/liste?period=${period}&tip=gainers&limit=5`).then(r => r.json()),
                fetch(`${WORKER_URL}/liste?period=${period}&tip=losers&limit=5`).then(r => r.json())
            ]);

            if (rg && rg.lista && rg.lista.length) {
                gEl.innerHTML = rg.lista.map(red).join('');
            } else {
                gEl.innerHTML = '<div class="liste-loading">Nema podataka</div>';
            }

            if (rl && rl.lista && rl.lista.length) {
                lEl.innerHTML = rl.lista.map(red).join('');
            } else {
                lEl.innerHTML = '<div class="liste-loading">Nema podataka</div>';
            }
        } catch (e) {
            console.warn('Liste greška:', e);
            if (gEl) gEl.innerHTML = '<div class="liste-loading">Greška</div>';
            if (lEl) lEl.innerHTML = '<div class="liste-loading">Greška</div>';
        }
    }

    skeleton();

    const sel = document.getElementById('liste-period');
    if (sel) {
        sel.addEventListener('change', () => {
            period = sel.value;
            ucitaj();
        });
    }

    ucitaj();
    setInterval(ucitaj, 60000); // 1x/min
})();
