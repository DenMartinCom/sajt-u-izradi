// ===== PRAĆENJE ADRESE (ETH / USDT / ZAMA) =====
// 1. Korisnik unese adresu i izabere token
// 2. Sajt uzme prethodni balans iz D1 (get-balans)
// 3. Svakih 15s proverava balans (Etherscan preko Workera)
// 4. Ako se promeni → cena (CoinGecko, CMC rezerva) → poruka + zvuk + mejl
// 5. Zaustavi praćenje posle prve promene

(function () {
    const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
    const STORAGE_ADRESA = 'watch_address_v1';
    const STORAGE_TOKEN = 'watch_token_v1';
    const INTERVAL = 15000; // 15 sekundi

    // Konfiguracija kripta — jedan red po kriptu
    const KRIPTO = {
        eth:  { coingecko: 'ethereum', cmc: 1027,  delilac: 1e18, contract: null },
        usdt: { coingecko: 'tether',   cmc: 825,   delilac: 1e6,  contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
        zama: { coingecko: 'zama',     cmc: 39332, delilac: 1e18, contract: '0xA12CC123ba206d4031D1c7f6223D1C2Ec249f4f3' }
    };

    let trenutnaAdresa = null;
    let trenutniToken = null;
    let intervalId = null;

    // --- UI elementi ---
    const inputEl = document.getElementById('eth-adresa');
    const selectEl = document.getElementById('token-izbor');
    const btnEl = document.getElementById('eth-prati-btn');
    const statusEl = document.getElementById('adresa-status');

    if (!inputEl || !selectEl || !btnEl || !statusEl) return;

    function setStatus(text, type = '') {
        statusEl.textContent = text;
        statusEl.className = 'adresa-status' + (type ? ' ' + type : '');
    }

    function validnaAdresa(a) {
        return /^0x[a-fA-F0-9]{40}$/.test(a);
    }

    // --- Dohvati balans sa Workera (Etherscan proxy) ---
    async function dohvatiBalans(adresa, token) {
        const config = KRIPTO[token];
        if (!config) throw new Error('Nepoznat token');

        let url = `${WORKER_URL}/balance?address=${adresa}`;
        if (config.contract) url += `&contract=${config.contract}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        if (data.status !== '1') {
            throw new Error(data.message || 'Etherscan greška');
        }

        // Sirovi balans / delilac
        const sirovi = data.result;
        const balans = parseFloat(sirovi) / config.delilac;
        return { sirovi, balans };
    }

    // --- Dohvati prethodni balans iz D1 ---
    async function dohvatiPrethodni(adresa, token) {
        try {
            const res = await fetch(`${WORKER_URL}/get-balans?adresa=${adresa}&token=${token}`);
            if (!res.ok) return null;
            const data = await res.json();
            if (data.ok && data.podaci) return data.podaci;
        } catch (e) {
            console.warn('get-balans greška:', e);
        }
        return null;
    }

    // --- Sačuvaj balans u D1 ---
    async function sacuvajBalans(adresa, token, balans, balansUsd) {
        try {
            const url = `${WORKER_URL}/save-balans?adresa=${adresa}&token=${token}&balans=${encodeURIComponent(balans)}` +
                (balansUsd !== null ? `&balans_usd=${balansUsd}` : '');
            await fetch(url);
        } catch (e) {
            console.warn('save-balans greška:', e);
        }
    }

    // --- Dohvati cenu (CoinGecko, CMC rezerva) ---
    async function dohvatiCenu(token) {
        const config = KRIPTO[token];
        if (!config) return null;

        // 1. CoinGecko
        try {
            const res = await fetch(`${WORKER_URL}/coingecko?ids=${config.coingecko}`);
            const data = await res.json();
            if (data && data[config.coingecko] && typeof data[config.coingecko].usd === 'number') {
                return data[config.coingecko].usd;
            }
        } catch (e) {
            console.warn('CoinGecko greška:', e);
        }

        // 2. CMC rezerva
        try {
            const res = await fetch(`${WORKER_URL}/cmc`);
            const data = await res.json();
            const id = String(config.cmc);
            if (data && data.data && data.data[id] && data.data[id].quote && data.data[id].quote.USD) {
                return data.data[id].quote.USD.price;
            }
        } catch (e) {
            console.warn('CMC greška:', e);
        }

        return null;
    }

    // --- Formatiraj broj lepo (npr. 100, 0.5, 1.234) ---
    function formatBroj(n) {
        if (Math.abs(n) >= 1) return n.toFixed(2);
        if (Math.abs(n) >= 0.01) return n.toFixed(4);
        return n.toFixed(6);
    }

    // --- Provera (jedan ciklus) ---
    async function proveri() {
        if (!trenutnaAdresa || !trenutniToken) return;

        try {
            // 1. Trenutni balans sa Etherscan-a
            const { sirovi, balans } = await dohvatiBalans(trenutnaAdresa, trenutniToken);

            // 2. Prethodni balans iz D1
            const prethodni = await dohvatiPrethodni(trenutnaAdresa, trenutniToken);

            // Prvi put — nema prethodnog u bazi
            if (!prethodni) {
                const cena = await dohvatiCenu(trenutniToken);
                if (cena === null) {
                    setStatus('Probajte kasnije', 'error');
                    return;
                }
                const usd = balans * cena;
                await sacuvajBalans(trenutnaAdresa, trenutniToken, sirovi, usd.toFixed(2));
                setStatus(`Pratim • ${formatBroj(balans)} ${trenutniToken.toUpperCase()} ($${usd.toFixed(2)})`, 'ok');
                return;
            }

            // 3. Uporedi balanse
            const prethodniSirovi = prethodni.balans;
            if (sirovi === prethodniSirovi) {
                // Nema promene — samo osveži status (opciono)
                return;
            }

            // 4. Ima promene — dohvati cenu
            const cena = await dohvatiCenu(trenutniToken);
            if (cena === null) {
                setStatus('Probajte kasnije', 'error');
                return;
            }

            const prethodniBalans = parseFloat(prethodniSirovi) / KRIPTO[trenutniToken].delilac;
            const razlika = balans - prethodniBalans;
            const razlikaUsd = Math.abs(razlika) * cena;

            const smer = razlika > 0 ? 'Stiglo' : 'Otišlo';
            const poruka = `${smer} ${formatBroj(Math.abs(razlika))} ${trenutniToken.toUpperCase()}, oko $${razlikaUsd.toFixed(2)}`;

            // Prikaz
            setStatus(poruka, 'ok');

            // Zvuk
            if (window.playMinimumSound) window.playMinimumSound();

            // Mejl
            if (window.posaljiEmailMinimum) {
                window.posaljiEmailMinimum({
                    poruka: poruka,
                    time: new Date().toLocaleString('sr-RS')
                });
            }

            // Sačuvaj novi balans u D1
            await sacuvajBalans(trenutnaAdresa, trenutniToken, sirovi, (balans * cena).toFixed(2));

            // Zaustavi praćenje posle prve promene
            if (intervalId) {
                clearInterval(intervalId);
                intervalId = null;
            }

        } catch (e) {
            console.warn('Greška pri proveri:', e);
            setStatus('Probajte kasnije', 'error');
        }
    }

    // --- Pokreni praćenje ---
    function pokreniPracenje(adresa, token) {
        if (intervalId) clearInterval(intervalId);
        trenutnaAdresa = adresa;
        trenutniToken = token;
        setStatus('Učitavanje...');
        proveri();
        intervalId = setInterval(proveri, INTERVAL);
    }

    // --- Klik na dugme ---
    btnEl.addEventListener('click', () => {
        const a = inputEl.value.trim();
        const t = selectEl.value;

        if (!validnaAdresa(a)) {
            setStatus('Neispravna adresa (mora biti 0x + 40 hex znakova)', 'error');
            return;
        }
        if (!KRIPTO[t]) {
            setStatus('Nepoznat token', 'error');
            return;
        }

        try {
            localStorage.setItem(STORAGE_ADRESA, a);
            localStorage.setItem(STORAGE_TOKEN, t);
        } catch (e) {}

        pokreniPracenje(a, t);
    });

    // Enter u input-u
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnEl.click();
    });

    // --- Init — učitaj sačuvano ---
    try {
        const a = localStorage.getItem(STORAGE_ADRESA);
        const t = localStorage.getItem(STORAGE_TOKEN) || 'eth';
        if (a && validnaAdresa(a)) {
            inputEl.value = a;
            selectEl.value = t;
            pokreniPracenje(a, t);
        }
    } catch (e) {}

})();
