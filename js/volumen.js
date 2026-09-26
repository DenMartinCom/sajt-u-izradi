// ===== VOLUMEN — promena volumena trgovanja =====
// Prikazuje top 10 tokena po promeni volumena (gainers/losers)
// Za izabrani period. Izvor: /volumen (kripto_kes tabela).
// Prikaz identičan cene.js: logo | simbol | cena | promena%
(function () {
    const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
    const el = document.getElementById('volumen-widget');
    if (!el) return;

    let period = '24h';

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
                <div class="liste-title">Volumen spot trgovanja, promena Top 10</div>
                <div class="cd" id="volumen-cd">
                    <button class="cd-toggle" type="button">${period}</button>
                    <div class="cd-menu">${opcije}</div>
                </div>
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

    function initDropdown() {
        const cd = document.getElementById('volumen-cd');
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