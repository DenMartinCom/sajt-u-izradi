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
        return znak + Math.round(n) + '%';
    }

    function cmcUrl(c) {
        const slug = c.cmc_slug || c.simbol;
        return 'https://coinmarketcap.com/currencies/' + encodeURIComponent(slug) + '/';
    }

    function napraviItem(c) {
        const prom = c.promena_24h != null ? c.promena_24h : c.promena;
        const kl = prom != null ? (prom >= 0 ? 'up' : 'down') : '';
        return `<a class="marquee-item" href="${cmcUrl(c)}" target="_blank" rel="noopener">
            <img src="${c.logo}" alt="${c.simbol}" loading="lazy" onerror="if(!this.dataset.err){this.dataset.err=1; this.src='Slike/coins/_default.png';}">
            <span class="m-simbol">${c.simbol}</span>
            <span class="m-cena">${formatCena(c.cena)}</span>
            ${prom != null ? `<span class="m-promena ${kl}">${formatPromena(prom)}</span>` : ''}
        </a>`;
    }

    async function ucitaj() {
        try {
            const r = await fetch(`${WORKER_URL}/marquee`);
            const d = await r.json();
            if (!d || d.error) {
                el.innerHTML = '<div class="marquee-loading">Greška pri učitavanju</div>';
                return;
            }

            const gornji = [...(d.set1 || []), ...(d.fiksni || [])];
            const donji = [...(d.set2 || []), ...(d.set3 || [])];

            // Dupliraj listu za beskonačnu animaciju (2x isti sadržaj)
            const gornjiHtml = gornji.map(napraviItem).join('') + gornji.map(napraviItem).join('');
            const donjiHtml = donji.map(napraviItem).join('') + donji.map(napraviItem).join('');

            el.innerHTML = `
                <div class="marquee-track">${gornjiHtml}</div>
                <div class="marquee-track fiksni">${donjiHtml}</div>
            `;
        } catch (e) {
            console.warn('Marquee greška:', e);
        }
    }

    // Učitaj SAMO JEDNOM — bez refreša (da ne resetuje animaciju)
    ucitaj();
})();
