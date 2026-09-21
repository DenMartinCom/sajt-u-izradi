// ===== MARQUEE =====
(function () {
    const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
    const el = document.getElementById('marquee-widget');
    if (!el) return;

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

    function napraviItem(c) {
        const prom = c.promena_24h != null ? c.promena_24h : c.promena;
        const kl = prom != null ? (prom >= 0 ? 'up' : 'down') : '';
        return `<a class="marquee-item" href="${cmcUrl(c.simbol)}" target="_blank" rel="noopener">
            <img src="${c.logo}" alt="${c.simbol}" onerror="this.src='Slike/coins/_default.png'">
            <span class="m-simbol">${c.simbol}</span>
            <span class="m-cena">${formatCena(c.cena)}</span>
            ${prom != null ? `<span class="m-promena ${kl}">${formatPromena(prom)}</span>` : ''}
        </a>`;
    }

    let podaci = null;
    let rotacija = 0;

    function prikazi() {
        if (!podaci) return;

        const setevi = [podaci.set1, podaci.set2, podaci.set3];
        const gornji = setevi[rotacija % setevi.length] || [];
        const donji = podaci.fiksni || [];

        // Izbaci fiksne iz gornjeg ako se ponavljaju
        const fiksniSimboli = donji.map(x => x.simbol);
        const gornjiFiltrirano = gornji.filter(x => !fiksniSimboli.includes(x.simbol));

        el.innerHTML = `
            <div class="marquee-row">${gornjiFiltrirano.map(napraviItem).join('')}</div>
            <div class="marquee-row fiksni">${donji.map(napraviItem).join('')}</div>
        `;
    }

    async function ucitaj() {
        try {
            const r = await fetch(`${WORKER_URL}/marquee`);
            const d = await r.json();
            if (d && !d.error) {
                podaci = d;
                prikazi();
            } else {
                el.innerHTML = '<div class="marquee-loading">Greška pri učitavanju</div>';
            }
        } catch (e) {
            console.warn('Marquee greška:', e);
        }
    }

    ucitaj();
    setInterval(ucitaj, 60000); // osvežavanje podataka 1x/min

    setInterval(() => {
        rotacija++;
        prikazi();
    }, 30000); // rotacija setova 30s
})();
