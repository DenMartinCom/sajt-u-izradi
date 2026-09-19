// ===== PRAĆENJE ADRESE (ETH / USDT / ZAMA) =====
// 1. Korisnik unese adresu i izabere token
// 2. Sajt uzme prethodni balans iz D1 (get-balans)
// 3. Svakih 15s proverava balans (Etherscan preko Workera)
// 4. Ako se promeni → cena (CoinGecko → CMC → cache) → poruka + zvuk + mejl
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

    // ===== NIVO 2: fetch sa retry (3 pokušaja, 1s pauza) =====
    async function fetchSaRetry(url, pokusaja = 3, pauzaMs = 1000) {
        for (let i = 0; i < pokusaja; i++) {
            try {
                const res = await fetch(url);
                if (!res.ok) {
                    console.warn(`Pokušaj ${i + 1} nije OK (HTTP ${res.status}):`, url);
                    if (i < pokusaja - 1) {
                        await new Promise(r => setTimeout(r, pauzaMs));
                        continue;
                    }
                    return null;
                }

                const tekst = await res.text();
                try {
                    return JSON.parse(tekst);
                } catch (jsonErr) {
                    console.warn(`Pokušaj ${i + 1} — nevalidan JSON (${tekst.slice(0, 50)}...):`, url);
                    if (i < pokusaja - 1) {
                        await new Promise(r => setTimeout(r, pauzaMs));
                        continue;
                    }
                    return null;
                }
            } catch (e) {
                console.warn(`Pokušaj ${i + 1} greška (mreža):`, e.message);
                if (i < pokusaja - 1) {
                    await new Promise(r => setTimeout(r, pauzaMs));
                    continue;
                }
                return null;
            }
        }
        return null;
    }

    // --- Dohvati balans sa Workera (Etherscan proxy) ---
    async function dohvatiBalans(adresa, token) {
        const config = KRIPTO[token];
        if (!config) throw new Error('Nepoznat token');

        let url = `${WORKER_URL}/balance?address=${adresa}`;
        if (config.contract) url += `&contract=${config.contract}`;

        const data = await fetchSaRetry(url);
        if (!data) throw new Error('Etherscan nedostupan');

        if (data.status !== '1') {
            throw new Error(data.message || 'Etherscan greška');
        }

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
            let url = `${WORKER_URL}/save-balans?adresa=${adresa}&token=${token}&balans=${encodeURIComponent(balans)}`;
            if (balansUsd !== null && balansUsd !== undefined) {
                url += `&balans_usd=${balansUsd}`;
            }
            await fetch(url);
        } catch (e) {
            console.warn('save-balans greška:', e);
        }
    }

    // --- Dohvati poslednju poznatu cenu iz D1 (nivo 3) ---
    async function dohvatiCacheCenu(adresa, token) {
        try {
            const res = await fetch(`${WORKER_URL}/get-balans?adresa=${adresa}&token=${token}`);
            if (!res.ok) return null;
            const data = await res.json();
            if (data.ok && data.podaci && data.podaci.balans_usd && data.podaci.balans) {
                const balans = parseFloat(data.podaci.balans) / KRIPTO[token].delilac;
                if (balans > 0) {
                    return parseFloat(data.podaci.balans_usd) / balans;
                }
            }
        } catch (e) {
            console.warn('cache cena greška:', e);
        }
        return null;
    }

    // ===== NIVO 1 + 2 + 3: cena sa fallback-om =====
    async function dohvatiCenu(token, adresa) {
        const config = KRIPTO[token];
        if (!config) return null;

        // === NIVO 1: CoinGecko (sa retry) ===
        try {
            const data = await fetchSaRetry(`${WORKER_URL}/coingecko?ids=${config.coingecko}`);
            if (data && data[config.coingecko] && typeof data[config.coingecko].usd === 'number') {
                console.log('✅ Cena sa CoinGecko:', data[config.coingecko].usd);
                return data[config.coingecko].usd;
            }
            console.warn('⚠️ CoinGecko nije vratio cenu, probavam CMC...', data);
        } catch (e) {
            console.warn('⚠️ CoinGecko pao (mreža):', e.message);
        }

        // === NIVO 1: CMC rezerva (sa retry) ===
        try {
            const data = await fetchSaRetry(`${WORKER_URL}/cmc`);
            const id = String(config.cmc);
            if (data && data.data && data.data[id] && data.data[id].quote && data.data[id].quote.USD) {
                console.log('✅ Cena sa CMC:', data.data[id].quote.USD.price);
                return data.data[id].quote.USD.price;
            }
            console.warn('⚠️ CMC nije vratio cenu:', data);
        } catch (e) {
            console.warn('⚠️ CMC pao (mreža):', e.message);
        }

        // === NIVO 3: cache iz D1 ===
        if (adresa) {
            const cacheCena = await dohvatiCacheCenu(adresa, token);
            if (cacheCena !== null) {
                console.log('✅ Cena iz cache-a (D1):', cacheCena);
                return cacheCena;
            }
        }

        console.error('❌ Nijedan izvor nije vratio cenu za', token);
        return null;
    }

    // --- Formatiraj broj lepo ---
    function formatBroj(n) {
        if (Math.abs(n) >= 1) return n.toFixed(2);
        if (Math.abs(n) >= 0.01) return n.toFixed(4);
        return n.toFixed(6);
    }

    // --- Provera (jedan ciklus) ---
    async function proveri() {
        if (!trenutnaAdresa || !trenutniToken) return;

        try {
            const { sirovi, balans } = await dohvatiBalans(trenutnaAdresa, trenutniToken);
            const prethodni = await dohvatiPrethodni(trenutnaAdresa, trenutniToken);

            // ===== Prvi put — nema prethodnog u bazi =====
            if (!prethodni) {
                // Ako je balans 0, sačekaj uplatu — ne treba cena
                if (balans === 0) {
                    await sacuvajBalans(trenutnaAdresa, trenutniToken, sirovi, '0');
                    setStatus(`Čekam uplatu ${trenutniToken.toUpperCase()}...`, 'ok');
                    return;
                }

                // Ako ima balansa, pokušaj da dobiješ cenu
                const cena = await dohvatiCenu(trenutniToken, trenutnaAdresa);
                if (cena === null) {
                    // Nema cene — prikaži bar količinu
                    await sacuvajBalans(trenutnaAdresa, trenutniToken, sirovi, null);
                    setStatus(`Pratim • ${formatBroj(balans)} ${trenutniToken.toUpperCase()} (cena nedostupna)`, 'ok');
                    return;
                }
                const usd = balans * cena;
                await sacuvajBalans(trenutnaAdresa, trenutniToken, sirovi, usd.toFixed(2));
                setStatus(`Pratim • ${formatBroj(balans)} ${trenutniToken.toUpperCase()} ($${usd.toFixed(2)})`, 'ok');
                return;
            }

            // ===== Uporedi balanse =====
            const prethodniSirovi = prethodni.balans;
            if (sirovi === prethodniSirovi) {
                return; // nema promene
            }

            // ===== Ima promene — izračunaj razliku =====
            const prethodniBalans = parseFloat(prethodniSirovi) / KRIPTO[trenutniToken].delilac;
            const razlika = balans - prethodniBalans;
            const smer = razlika > 0 ? 'Stiglo' : 'Otišlo';

            // Dohvati cenu za USD (može biti null)
            const cena = await dohvatiCenu(trenutniToken, trenutnaAdresa);

            let poruka;
            let balansUsdZaUpis = null;

            if (cena === null) {
                // Nema cene — prikaži bar količinu
                poruka = `${smer} ${formatBroj(Math.abs(razlika))} ${trenutniToken.toUpperCase()}`;
            } else {
                const razlikaUsd = Math.abs(razlika) * cena;
                poruka = `${smer} ${formatBroj(Math.abs(razlika))} ${trenutniToken.toUpperCase()}, oko $${razlikaUsd.toFixed(2)}`;
                balansUsdZaUpis = (balans * cena).toFixed(2);
            }

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
            await sacuvajBalans(trenutnaAdresa, trenutniToken, sirovi, balansUsdZaUpis);

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

    // --- Init — popuni polja iz localStorage, ali NE pokreći praćenje ---
    try {
        const a = localStorage.getItem(STORAGE_ADRESA);
        const t = localStorage.getItem(STORAGE_TOKEN) || 'eth';
        if (a && validnaAdresa(a)) {
            inputEl.value = a;
            selectEl.value = t;
        }
    } catch (e) {}

})();
