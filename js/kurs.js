// ===== KURS + KALKULATOR =====
(function () {
    const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';

    // Kod valute → kod države za zastavicu (flagcdn.com)
    const ZASTAVE = {
        EUR: 'eu', USD: 'us', CHF: 'ch', GBP: 'gb', RUB: 'ru', BAM: 'ba', RSD: 'rs',
        JPY: 'jp', CNY: 'cn', CAD: 'ca', AUD: 'au', SEK: 'se', NOK: 'no',
        DKK: 'dk', CZK: 'cz', PLN: 'pl', HUF: 'hu', RON: 'ro', TRY: 'tr',
        INR: 'in', KWD: 'kw', MKD: 'mk', AED: 'ae', BYN: 'by', XDR: 'un',
        ATS: 'at', BEF: 'be', DEM: 'de', ESP: 'es', FIM: 'fi', FRF: 'fr',
        GRD: 'gr', IEP: 'ie', ITL: 'it', LUF: 'lu', PTE: 'pt'
    };

    const PRIKAZ = ['EUR', 'USD', 'CHF', 'GBP', 'RUB', 'BAM'];

    const gridEl = document.getElementById('kurs-grid');
    const viseEl = document.getElementById('kurs-vise');
    const inputEl = document.getElementById('kalk-iznos');
    const valutaEl = document.getElementById('kalk-valuta');
    const smerEl = document.getElementById('kalk-smer');
    const rezultatEl = document.getElementById('kalk-rezultat');

    if (!gridEl) return;

    let kurs = null;
    let prikazSve = false;
    let smer = 'valuta_u_rsd'; // ili 'rsd_u_valuta'

    function formatKurs(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '—';
        return n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatRezultat(n, tip) {
        if (typeof n !== 'number' || !isFinite(n)) return '—';
        if (tip === 'rsd') return n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' RSD';
        return n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
    }

    function napraviValutu(kod) {
        const vrednost = kurs && kurs.valute && kurs.valute[kod] != null ? kurs.valute[kod] : null;
        const drzava = ZASTAVE[kod] || 'un';
        const flagUrl = `https://flagcdn.com/w40/${drzava}.png`;
        const vrednostTekst = vrednost != null ? formatKurs(vrednost) : '—';
        return `<div class="kurs-valuta" data-valuta="${kod}">
            <img src="${flagUrl}" alt="${kod}" loading="lazy" onerror="this.style.display='none'">
            <span class="kv-kod">${kod}</span>
            <span class="kv-vrednost">${vrednostTekst}</span>
        </div>`;
    }

    function iscrtajGrid() {
        if (!kurs) return;
        if (prikazSve && kurs.valute) {
            const svi = Object.keys(kurs.valute).sort();
            gridEl.innerHTML = svi.map(napraviValutu).join('');
        } else {
            gridEl.innerHTML = PRIKAZ.map(napraviValutu).join('');
        }
    }

    function izracunaj() {
        if (!kurs || !kurs.valute) {
            if (rezultatEl) rezultatEl.textContent = '—';
            return;
        }
        const iznos = parseFloat(inputEl.value);
        if (!isFinite(iznos)) {
            rezultatEl.textContent = '—';
            return;
        }
        const kod = valutaEl.value;
        const k = kurs.valute[kod];
        if (!k) {
            rezultatEl.textContent = 'nema kursa';
            return;
        }

        if (smer === 'valuta_u_rsd') {
            // imam X valute, koliko je to RSD
            const rsd = iznos * k;
            rezultatEl.textContent = formatRezultat(rsd, 'rsd');
        } else {
            // imam X RSD, koliko je to valute
            const valuta = iznos / k;
            rezultatEl.textContent = formatRezultat(valuta, 'valuta') + ' ' + kod;
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

    // Prikaži sve / prikaži osnovne
    if (viseEl) {
        viseEl.addEventListener('click', () => {
            prikazSve = !prikazSve;
            iscrtajGrid();
            viseEl.textContent = prikazSve ? 'Prikaži osnovne valute ↑' : 'Prikaži sve valute ↓';
        });
    }

    // Promena valute u kalkulatoru
    if (valutaEl) {
        valutaEl.addEventListener('change', izracunaj);
    }

    // Promena iznosa
    if (inputEl) {
        inputEl.addEventListener('input', izracunaj);
    }

    // Promena smera
    if (smerEl) {
        smerEl.addEventListener('click', () => {
            smer = smer === 'valuta_u_rsd' ? 'rsd_u_valuta' : 'valuta_u_rsd';
            inputEl.value = smer === 'valuta_u_rsd' ? '1000' : '10000';
            izracunaj();
        });
    }

    ucitaj();
    setInterval(ucitaj, 5 * 60 * 1000); // osvežavanje 5 min
})();
