// ===== KURS + KALKULATOR =====
(function () {
    const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';

    // kod valute → { naziv, drzava (za flagcdn) }
    const VALUTE_META = {
        EUR: { naziv: 'evro', drzava: 'eu' },
        USD: { naziv: 'dolar', drzava: 'us' },
        CHF: { naziv: 'franak', drzava: 'ch' },
        GBP: { naziv: 'funta', drzava: 'gb' },
        RUB: { naziv: 'rublja', drzava: 'ru' },
        BAM: { naziv: 'marka', drzava: 'ba' },
        RSD: { naziv: 'dinar', drzava: 'rs' },
        JPY: { naziv: 'jen', drzava: 'jp' },
        CNY: { naziv: 'juan', drzava: 'cn' },
        CAD: { naziv: 'dolar', drzava: 'ca' },
        AUD: { naziv: 'dolar', drzava: 'au' },
        SEK: { naziv: 'kruna', drzava: 'se' },
        NOK: { naziv: 'kruna', drzava: 'no' },
        DKK: { naziv: 'kruna', drzava: 'dk' },
        CZK: { naziv: 'kruna', drzava: 'cz' },
        PLN: { naziv: 'zlot', drzava: 'pl' },
        HUF: { naziv: 'forinta', drzava: 'hu' },
        RON: { naziv: 'lej', drzava: 'ro' },
        TRY: { naziv: 'lira', drzava: 'tr' },
        INR: { naziv: 'rupija', drzava: 'in' },
        KWD: { naziv: 'dinar', drzava: 'kw' },
        MKD: { naziv: 'denar', drzava: 'mk' },
        AED: { naziv: 'dirham', drzava: 'ae' },
        BYN: { naziv: 'rublja', drzava: 'by' },
        XDR: { naziv: 'SDR', drzava: 'un' },
        ATS: { naziv: 'šiling', drzava: 'at' },
        BEF: { naziv: 'franak', drzava: 'be' },
        DEM: { naziv: 'marka', drzava: 'de' },
        ESP: { naziv: 'pezeta', drzava: 'es' },
        FIM: { naziv: 'marka', drzava: 'fi' },
        FRF: { naziv: 'franak', drzava: 'fr' },
        GRD: { naziv: 'drahmi', drzava: 'gr' },
        IEP: { naziv: 'funta', drzava: 'ie' },
        ITL: { naziv: 'lira', drzava: 'it' },
        LUF: { naziv: 'franak', drzava: 'lu' },
        PTE: { naziv: 'eskudo', drzava: 'pt' }
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

    function drzavaZa(kod) {
        return (VALUTE_META[kod] && VALUTE_META[kod].drzava) ? VALUTE_META[kod].drzava : 'un';
    }

    function nazivZa(kod) {
        return (VALUTE_META[kod] && VALUTE_META[kod].naziv) ? VALUTE_META[kod].naziv : kod;
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
        const drzava = drzavaZa(kod);
        const naziv = nazivZa(kod);
        const flagUrl = `https://flagcdn.com/w40/${drzava}.png`;
        const vrednostTekst = vrednost != null ? formatKurs(vrednost) : '—';
        return `<div class="kurs-valuta" data-valuta="${kod}">
            <img src="${flagUrl}" alt="${kod}" loading="lazy" onerror="this.style.display='none'">
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
        const drzavaVal = drzavaZa(kod);

        if (smer === 'valuta_u_rsd') {
            flagLevo.src = `https://flagcdn.com/w40/${drzavaVal}.png`;
            flagLevo.alt = kod;
            flagDesno.src = `https://flagcdn.com/w40/rs.png`;
            flagDesno.alt = 'RSD';
        } else {
            flagLevo.src = `https://flagcdn.com/w40/rs.png`;
            flagLevo.alt = 'RSD';
            flagDesno.src = `https://flagcdn.com/w40/${drzavaVal}.png`;
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
