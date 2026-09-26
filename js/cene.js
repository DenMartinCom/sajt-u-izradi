// ===== CENE (gainers/losers) =====
(function () {
    const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
    const el = document.getElementById('liste-widget');
    if (!el) return;

    let period = '24h';

    // Bez volumenskih opcija — one idu u volumen.js
    const PERIODI = [
        { v: '1h',  t: '1h' },
        { v: '12h', t: '12h' },
        { v: '24h', t: '24h' },
        { v: '7d',  t: '7d' },
        { v: '14d', t: '14d' },
        { v: '30d', t: '30d' },
        { v: '60d', t: '60d' },
        { v: '90d', t: '90d' }
    ];

    function cmcUrl(c) {
        const slug = c.cmc_slug || c.simbol;
        return 'https://coinmarketcap.com/currencies/' + encodeURIComponent(slug) + '/';
    }

    function red(c) {
        const kl = c.promena >= 0 ? 'up' : 'down';
        const cenaTekst = c.cena != null ? '$' + window.formatCena(c.cena) : '—';
        const promTekst = c.promena != null ? window.formatProc(c.promena) + '%' : '';
        return `<a class="liste-red" href="${cmcUrl(c)}" target="_blank" rel="noopener">
            <img src="${c.logo}" alt="${c.simbol}" loading="lazy" onerror="if(!this.dataset.err){this.dataset.err=1; this.src='Slike/coins/_default.png';}">
            <span class="lr-simbol">${c.simbol}</span>
            <span class="lr-cena">${cenaTekst}</span>
            <span class="lr-promena ${kl}">${promTekst}</span>
        </a>`;
    }

    function skeleton() {
        const opcije = PERIODI.map(p =>
            `<div class="cd-item${p.v === period ? ' active' : ''}" data-value="${p.v}">${p.t}</div>`
        ).join('');
        el.innerHTML = `
            <div class="liste-header">
                <div class="liste-title">Cena, promena Top 5</div>
                <div class="cd" id="liste-cd">
                    <button class="cd-toggle" type="button">${period}</button>
                    <div class="cd-menu">${opcije}</div>
                </div>
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

    function initDropdown() {
        const cd = document.getElementById('liste-cd');
        if (!cd) return;
        const toggle = cd.querySelector('.cd-toggle');
        const menu = cd.querySelector('.cd-menu');

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const bioOtvoren = cd.classList.contains('open');
            cd.classList.toggle('open');
            if (!bioOtvoren) {
                const active = menu.querySelector('.cd-item.active');
                if (active) active.scrollIntoView({ block: 'nearest' });
            }
        });

        menu.addEventListener('click', (e) => {
            const item = e.target.closest('.cd-item');
            if (!item) return;
            const val = item.dataset.value;
            period = val;
            toggle.textContent = val;
            menu.querySelectorAll('.cd-item').forEach(x => x.classList.toggle('active', x.dataset.value === val));
            cd.classList.remove('open');
            ucitaj();
        });

        document.addEventListener('click', () => cd.classList.remove('open'));
    }

    skeleton();
    initDropdown();
    ucitaj();
    setInterval(ucitaj, 60000);
})();