// ===== KURS + KALKULATOR =====
(function () {
    const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';

    // kod valute → naziv (za prikaz)
    const VALUTE_META = {
        EUR: { naziv: 'evro' },
        USD: { naziv: 'dolar' },
        CHF: { naziv: 'franak' },
        GBP: { naziv: 'funta' },
        RUB: { naziv: 'rublja' },
        BAM: { naziv: 'marka' },
        RSD: { naziv: 'dinar' },
        JPY: { naziv: 'jen' },
        CNY: { naziv: 'juan' },
        CAD: { naziv: 'dolar' },
        AUD: { naziv: 'dolar' },
        SEK: { naziv: 'kruna' },
        NOK: { naziv: 'kruna' },
        DKK: { naziv: 'kruna' },
        CZK: { naziv: 'kruna' },
        PLN: { naziv: 'zlot' },
        HUF: { naziv: 'forinta' },
        RON: { naziv: 'lej' },
        TRY: { naziv: 'lira' },
        INR: { naziv: 'rupija' },
        KWD: { naziv: 'dinar' },
        MKD: { naziv: 'denar' },
        AED: { naziv: 'dirham' },
        BYN: { naziv: 'rublja' },
        XDR: { naziv: 'SDR' },
        ATS: { naziv: 'šiling' },
        BEF: { naziv: 'franak' },
        DEM: { naziv: 'marka' },
        ESP: { naziv: 'pezeta' },
        FIM: { naziv: 'marka' },
        FRF: { naziv: 'franak' },
        GRD: { naziv: 'drahmi' },
        IEP: { naziv: 'funta' },
        ITL: { naziv: 'lira' },
        LUF: { naziv: 'franak' },
        PTE: { naziv: 'eskudo' }
    };

    const PRIKAZ = ['EUR', 'USD', 'CHF', 'GBP', 'RUB', 'BAM'];

    const gridEl = document.getElementById('kurs-grid');
    const viseEl = document.getElementById('kurs-vise');
    const inputEl = document.getElementById('kalk-iznos');
    const valutaEl = document.getElementById('kalk-valuta');
    const smerEl = document.getElementById('kalk-smer');
    const rezultatEl = document.getElementById('kalk-rezultat');
    const flagLevo = document.getElementById('kalk-flag-levo');
    const flagDesno = document.getElementById('kalk-flag-desno');

    if (!gridEl) return;

    let kurs = null;
    let prikazSve = false;
    let smer = 'valuta_u_rsd'; // ili 'rsd_u_valuta'

    function nazivZa(kod) {
        return (VALUTE_META[kod] && VALUTE_META[kod].naziv) ? VALUTE_META[kod].naziv : kod;
    }

    function zastavaUrl(kod) {
        return `Slike/zastavice/${kod}.png`;
    }

    function formatKurs(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '—';
        return n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatValuta(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '—';
        return n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatRsd(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '—';
        return n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' RSD';
    }

    function napraviValutu(kod) {
        const vrednost = kurs && kurs.valute && kurs.valute[kod] != null ? kurs.valute[kod] : null;
        const naziv = nazivZa(kod);
        const flagUrl = zastavaUrl(kod);
        const vrednostTekst = vrednost != null ? formatKurs(vrednost) : '—';
        return `<div class="kurs-valuta" data-valuta="${kod}">
            <img src="${flagUrl}" alt="${kod}" loading="lazy" onerror="if(!this.dataset.err){this.dataset.err=1; this.src='Slike/coins/_default.png';}">
            <span class="kv-kod">${kod}</span>
            <span class="kv-naziv">${naziv}</span>
            <span class="kv-vrednost">${vrednostTekst}</span>
        </div>`;
    }

    function iscrtajGrid() {
        if (!kurs || !kurs.valute) return;
        if (prikazSve) {
            const svi = Object.keys(kurs.valute).sort();
            gridEl.innerHTML = svi.map(napraviValutu).join('');
        } else {
            gridEl.innerHTML = PRIKAZ.map(napraviValutu).join('');
        }
    }

    function azurirajPlaceholder() {
        if (!inputEl || !valutaEl) return;
        const kod = valutaEl.value;
        if (smer === 'valuta_u_rsd') {
            inputEl.placeholder = 'Količina u ' + kod;
        } else {
            inputEl.placeholder = 'Količina u RSD';
        }
    }

    // Ažurira zastavice iznad polja u kalkulatoru, u zavisnosti od smera
    function azurirajZastavice() {
        if (!flagLevo || !flagDesno) return;
        const kod = valutaEl.value;

        if (smer === 'valuta_u_rsd') {
            flagLevo.src = zastavaUrl(kod);
            flagLevo.alt = kod;
            flagDesno.src = zastavaUrl('RSD');
            flagDesno.alt = 'RSD';
        } else {
            flagLevo.src = zastavaUrl('RSD');
            flagLevo.alt = 'RSD';
            flagDesno.src = zastavaUrl(kod);
            flagDesno.alt = kod;
        }
    }

    function izracunaj() {
        if (!kurs || !kurs.valute) {
            if (rezultatEl) rezultatEl.textContent = '—';
            return;
        }
        const tekst = (inputEl.value || '').trim();
        if (!tekst) {
            rezultatEl.textContent = '—';
            return;
        }
        const iznos = parseFloat(tekst);
        if (!isFinite(iznos)) {
            rezultatEl.textContent = '—';
            return;
        }
        const kod = valutaEl.value;
        const k = kurs.valute[kod];
        if (!k) {
            rezultatEl.textContent = 'nema kursa za ' + kod;
            return;
        }

        if (smer === 'valuta_u_rsd') {
            const rsd = iznos * k;
            rezultatEl.textContent = formatRsd(rsd);
        } else {
            const valuta = iznos / k;
            rezultatEl.textContent = formatValuta(valuta) + ' ' + kod;
        }
    }

    async function ucitaj() {
        try {
            const r = await fetch(`${WORKER_URL}/kurs`);
            const d = await r.json();
            if (d && !d.error && d.valute) {
                kurs = d;
                iscrtajGrid();
                izracunaj();
            }
        } catch (e) {
            console.warn('Kurs greška:', e);
        }
    }

    if (viseEl) {
        viseEl.addEventListener('click', () => {
            prikazSve = !prikazSve;
            iscrtajGrid();
            viseEl.textContent = prikazSve
                ? 'Prikaži osnovne valute ↑'
                : 'Prikaži sve valute srednjeg kursa dinara (RSD)';
        });
    }

    if (valutaEl) {
        valutaEl.addEventListener('change', () => {
            azurirajPlaceholder();
            azurirajZastavice();
            izracunaj();
        });
    }

    if (inputEl) {
        inputEl.addEventListener('input', izracunaj);
    }

    if (smerEl) {
        smerEl.addEventListener('click', () => {
            smer = smer === 'valuta_u_rsd' ? 'rsd_u_valuta' : 'valuta_u_rsd';
            azurirajPlaceholder();
            azurirajZastavice();
            izracunaj();
        });
    }

    azurirajPlaceholder();
    azurirajZastavice();
    ucitaj();
    setInterval(ucitaj, 5 * 60 * 1000);
})();
