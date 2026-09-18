
// ===== PRAĆENJE ETH ADRESE =====
// Kad se broj tokena promeni — zvuk + mejl
// Provera svakih 6 sekundi

(function () {
    const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
    const STORAGE_ADRESA = 'eth_watch_address_v1';
    const STORAGE_SNAPSHOT = 'eth_watch_snapshot_v1';
    const INTERVAL = 6000; // 6 sekundi

    let trenutnaAdresa = null;
    let intervalId = null;

    // --- UI elementi ---
    const inputEl = document.getElementById('eth-adresa');
    const btnEl = document.getElementById('eth-prati-btn');
    const statusEl = document.getElementById('adresa-status');

    if (!inputEl || !btnEl || !statusEl) return;

    function setStatus(text, type = '') {
        statusEl.textContent = text;
        statusEl.className = 'adresa-status' + (type ? ' ' + type : '');
    }

    // --- Učitaj sačuvanu adresu pri startu ---
    function ucitajSacuvanu() {
        try {
            const a = localStorage.getItem(STORAGE_ADRESA);
            if (a && /^0x[a-fA-F0-9]{40}$/.test(a)) {
                inputEl.value = a;
                pokreniPracenje(a);
            }
        } catch (e) {}
    }

    // --- Validacija adrese ---
    function validnaAdresa(a) {
        return /^0x[a-fA-F0-9]{40}$/.test(a);
    }

    // --- Snapshot iz localStorage ---
    function getSnapshot() {
        try {
            const s = localStorage.getItem(STORAGE_SNAPSHOT);
            return s ? JSON.parse(s) : null;
        } catch (e) { return null; }
    }
    function setSnapshot(snap) {
        try {
            localStorage.setItem(STORAGE_SNAPSHOT, JSON.stringify(snap));
        } catch (e) {}
    }

    // --- Dohvati stanje adrese sa workera ---
    async function dohvatiStanje(adresa) {
        const res = await fetch(`${WORKER_URL}/tokens?address=${adresa}`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    }

    // --- Provera (jedan ciklus) ---
    async function proveri() {
        if (!trenutnaAdresa) return;

        try {
            const stanje = await dohvatiStanje(trenutnaAdresa);

            if (stanje.error) {
                setStatus('Greška: ' + stanje.error, 'error');
                return;
            }

            const brojTokena = stanje.token_count;
            const ukupnoUsd = stanje.total_usd;

            const prethodni = getSnapshot();

            // Prvi put — samo sačuvaj snapshot
            if (!prethodni || prethodni.address !== trenutnaAdresa) {
                setSnapshot({
                    address: trenutnaAdresa,
                    token_count: brojTokena,
                    total_usd: ukupnoUsd,
                    time: Date.now()
                });
                setStatus(`Pratim • ${brojTokena} tokena • $${ukupnoUsd.toFixed(2)}`, 'ok');
                return;
            }

            // Ako se broj tokena promenio — alarm
            if (brojTokena !== prethodni.token_count) {
                const razlika = ukupnoUsd - prethodni.total_usd;

                // Zvuk
                if (window.playMinimumSound) window.playMinimumSound();

                // Mejl
                if (window.posaljiEmailMinimum) {
                    window.posaljiEmailMinimum({
                        sada_tokena: brojTokena,
                        sada_usd: ukupnoUsd.toFixed(2),
                        bilo_tokena: prethodni.token_count,
                        bilo_usd: prethodni.total_usd.toFixed(2),
                        razlika_usd: razlika.toFixed(2)
                    });
                }

                setStatus(
                    `Promena! ${prethodni.token_count} → ${brojTokena} tokena ($${ukupnoUsd.toFixed(2)})`,
                    'ok'
                );

                // Novi snapshot
                setSnapshot({
                    address: trenutnaAdresa,
                    token_count: brojTokena,
                    total_usd: ukupnoUsd,
                    time: Date.now()
                });
            } else {
                setStatus(`Pratim • ${brojTokena} tokena • $${ukupnoUsd.toFixed(2)}`, 'ok');
            }

        } catch (e) {
            console.warn('Greška pri proveri adrese:', e);
            setStatus('Greška u proveri', 'error');
        }
    }

    // --- Pokreni praćenje ---
    function pokreniPracenje(adresa) {
        if (intervalId) clearInterval(intervalId);
        trenutnaAdresa = adresa;
        setStatus('Učitavanje...');
        proveri();
        intervalId = setInterval(proveri, INTERVAL);
    }

    // --- Klik na dugme ---
    btnEl.addEventListener('click', () => {
        const a = inputEl.value.trim();
        if (!validnaAdresa(a)) {
            setStatus('Neispravna adresa (mora biti 0x + 40 hex znakova)', 'error');
            return;
        }
        // Reset snapshot-a za novu adresu
        try { localStorage.removeItem(STORAGE_SNAPSHOT); } catch (e) {}
        try { localStorage.setItem(STORAGE_ADRESA, a); } catch (e) {}
        pokreniPracenje(a);
    });

    // Enter u input-u
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnEl.click();
    });

    // Init
    ucitajSacuvanu();
})();
