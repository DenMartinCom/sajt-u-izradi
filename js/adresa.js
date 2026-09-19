// ===== PRAĆENJE ADRESE (ETH / USDT / ZAMA) =====

(function () {
    const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
    const STORAGE_ADRESA = 'watch_address_v1';
    const STORAGE_TOKEN = 'watch_token_v1';
    const INTERVAL = 15000;
    const CENA_KEŠ_MS = 5 * 60 * 1000;

    const KRIPTO = {
        eth:  { coingecko: 'ethereum', cmc: 1027,  delilac: 1e18, contract: null },
        usdt: { coingecko: 'tether',   cmc: 825,   delilac: 1e6,  contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
        zama: { coingecko: 'zama',     cmc: 39332, delilac: 1e18, contract: '0xA12CC123ba206d4031D1c7f6223D1C2Ec249f4f3' }
    };

    let trenutnaAdresa = null;
    let trenutniToken = null;
    let intervalId = null;
    let proveraUToku = false;
    let kešCena = {};

    const inputEl = document.getElementById('eth-adresa');
    const selectEl = document.getElementById('token-izbor');
    const btnEl = document.getElementById('eth-prati-btn');
    const statusEl = document.getElementById('adresa-status');

    if (!inputEl || !selectEl || !btnEl || !statusEl) return;

    // Formatiranje
    const fUsd = (n) => (typeof window.formatUsd === 'function') ? window.formatUsd(n) : n.toFixed(2);
    const fBroj = (n) => (typeof window.formatBroj === 'function') ? window.formatBroj(n) : n.toFixed(2);

    function setStatus(text, type = '') {
        statusEl.textContent = text;
        statusEl.className = 'adresa-status' + (type ? ' ' + type : '');
    }

    function validnaAdresa(a) {
        return /^0x[a-fA-F0-9]{40}$/.test(a);
    }

    async function fetchRL(url, opts) {
        const f = window.fetchRateLimited || fetch;
        return f(url, opts);
    }

    // ===== Retry + timeout (8s) =====
    async function fetchSaRetry(url, pokusaja = 2, pauzaMs = 500, timeoutMs = 8000) {
        for (let i = 0; i < pokusaja; i++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetchRL(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (!res.ok) {
                    console.warn(`Pokušaj ${i + 1} nije OK (HTTP ${res.status}):`, url);
                    if (i < pokusaja - 1) { await new Promise(r => setTimeout(r, pauzaMs)); continue; }
                    return null;
                }
                const tekst = await res.text();
                try {
                    return JSON.parse(tekst);
                } catch (jsonErr) {
                    console.warn(`Pokušaj ${i + 1} — nevalidan JSON:`, url);
                    if (i < pokusaja - 1) { await new Promise(r => setTimeout(r, pauzaMs)); continue; }
                    return null;
                }
            } catch (e) {
                clearTimeout(timeoutId);
                if (e.name === 'AbortError') {
                    console.warn(`Pokušaj ${i + 1} — timeout (${timeoutMs}ms):`, url);
                } else {
                    console.warn(`Pokušaj ${i + 1} greška (mreža):`, e.message);
                }
                if (i < pokusaja - 1) { await new Promise(r => setTimeout(r, pauzaMs)); continue; }
                return null;
            }
        }
        return null;
    }

    // --- Dohvati balans + cenu iz /balance ---
    async function dohvatiBalans(adresa, token) {
        const config = KRIPTO[token];
        if (!config) throw new Error('Nepoznat token');

        let url = `${WORKER_URL}/balance?address=${adresa}`;
        if (config.contract) url += `&contract=${config.contract}`;

        const data = await fetchSaRetry(url);
        if (!data) throw new Error('timeout');

        if (data.status !== '1') {
            throw new Error(data.message || 'Blockscout greška');
        }

        const sirovi = data.result;
        const balans = parseFloat(sirovi) / config.delilac;
        const cenaUsd = (typeof data.cena_usd === 'number') ? data.cena_usd : null;

        return { sirovi, balans, cenaUsd };
    }

    async function dohvatiPrethodni(adresa, token) {
        try {
            const res = await fetchRL(`${WORKER_URL}/get-balans?adresa=${adresa}&token=${token}`);
            if (!res.ok) return null;
            const data = await res.json();
            if (data.ok && data.podaci) return data.podaci;
        } catch (e) {
            console.warn('get-balans greška:', e);
        }
        return null;
    }

    async function sacuvajBalans(adresa, token, balans, balansUsd) {
        try {
            let url = `${WORKER_URL}/save-balans?adresa=${adresa}&token=${token}&balans=${encodeURIComponent(balans)}`;
            if (balansUsd !== null && balansUsd !== undefined) {
                url += `&balans_usd=${balansUsd}`;
            }
            await fetchRL(url);
        } catch (e) {
            console.warn('save-balans greška:', e);
        }
    }

    async function dohvatiCacheCenu(adresa, token) {
        try {
            const res = await fetchRL(`${WORKER_URL}/get-balans?adresa=${adresa}&token=${token}`);
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

    async function pokusajCoinGecko(token) {
        const config = KRIPTO[token];
        const data = await fetchSaRetry(`${WORKER_URL}/coingecko?ids=${config.coingecko}`);
        if (data && data[config.coingecko] && typeof data[config.coingecko].usd === 'number') {
            console.log('✅ Cena sa CoinGecko:', data[config.coingecko].usd);
            return data[config.coingecko].usd;
        }
        console.warn('⚠️ CoinGecko nije vratio cenu');
        return null;
    }

    async function pokusajCMC(token) {
        const config = KRIPTO[token];
        const data = await fetchSaRetry(`${WORKER_URL}/cmc`);
        const id = String(config.cmc);
        if (data && data.data && data.data[id] && data.data[id].price) {
            console.log('✅ Cena sa CMC:', data.data[id].price);
            return parseFloat(data.data[id].price);
        }
        console.warn('⚠️ CMC nije vratio cenu');
        return null;
    }

    async function dohvatiCenu(token, adresa) {
        if (kešCena[token] && (Date.now() - kešCena[token].vreme) < CENA_KEŠ_MS) {
            console.log('✅ Cena iz keša (u memoriji):', kešCena[token].vrednost);
            return kešCena[token].vrednost;
        }

        let cena = await pokusajCoinGecko(token);
        if (cena !== null) {
            kešCena[token] = { vrednost: cena, vreme: Date.now() };
            return cena;
        }
        cena = await pokusajCMC(token);
        if (cena !== null) {
            kešCena[token] = { vrednost: cena, vreme: Date.now() };
            return cena;
        }

        console.log('🔁 Drugi krug: CoinGecko → CMC');
        await new Promise(r => setTimeout(r, 800));

        cena = await pokusajCoinGecko(token);
        if (cena !== null) {
            kešCena[token] = { vrednost: cena, vreme: Date.now() };
            return cena;
        }
        cena = await pokusajCMC(token);
        if (cena !== null) {
            kešCena[token] = { vrednost: cena, vreme: Date.now() };
            return cena;
        }

        if (adresa) {
            const cacheCena = await dohvatiCacheCenu(adresa, token);
            if (cacheCena !== null) {
                console.log('✅ Cena iz cache-a (D1):', cacheCena);
                kešCena[token] = { vrednost: cacheCena, vreme: Date.now() };
                return cacheCena;
            }
        }

        console.error('❌ Nijedan izvor nije vratio cenu za', token);
        return null;
    }

    async function proveri() {
        if (!trenutnaAdresa || !trenutniToken) return;

        if (proveraUToku) {
            console.log('⏳ Prethodna provera još traje, preskačem...');
            return;
        }
        proveraUToku = true;

        try {
            const { sirovi, balans, cenaUsd } = await dohvatiBalans(trenutnaAdresa, trenutniToken);
            const prethodni = await dohvatiPrethodni(trenutnaAdresa, trenutniToken);

            // ===== Prvi put =====
            if (!prethodni) {
                if (balans === 0) {
                    await sacuvajBalans(trenutnaAdresa, trenutniToken, sirovi, '0');
                    setStatus(`Čekam uplatu ${trenutniToken.toUpperCase()}...`, 'ok');
                    return;
                }

                let cena = cenaUsd;
                if (cena === null) {
                    cena = await dohvatiCenu(trenutniToken, trenutnaAdresa);
                }

                if (cena === null) {
                    await sacuvajBalans(trenutnaAdresa, trenutniToken, sirovi, null);
                    setStatus(`Pratim • ${fBroj(balans)} ${trenutniToken.toUpperCase()} (cena nedostupna)`, 'ok');
                    return;
                }
                const usd = balans * cena;
                await sacuvajBalans(trenutnaAdresa, trenutniToken, sirovi, usd.toFixed(2));
                setStatus(`Pratim • ${fBroj(balans)} ${trenutniToken.toUpperCase()} ($${fUsd(usd)})`, 'ok');
                return;
            }

            // ===== Uporedi balanse =====
            const prethodniSirovi = prethodni.balans;
            if (sirovi === prethodniSirovi) {
                return;
            }

            // ===== Ima promene =====
            const prethodniBalans = parseFloat(prethodniSirovi) / KRIPTO[trenutniToken].delilac;
            const razlika = balans - prethodniBalans;
            const smer = razlika > 0 ? 'Stiglo' : 'Otišlo';

            let cena = cenaUsd;
            if (cena === null) {
                cena = await dohvatiCenu(trenutniToken, trenutnaAdresa);
            }

            let poruka;
            let balansUsdZaUpis = null;

            if (cena === null) {
                poruka = `${smer} ${fBroj(Math.abs(razlika))} ${trenutniToken.toUpperCase()}`;
            } else {
                const razlikaUsd = Math.abs(razlika) * cena;
                poruka = `${smer} ${fBroj(Math.abs(razlika))} ${trenutniToken.toUpperCase()}, oko $${fUsd(razlikaUsd)}`;
                balansUsdZaUpis = (balans * cena).toFixed(2);
            }

            setStatus(poruka, 'ok');

            if (window.playAdresaSound) window.playAdresaSound();

            if (window.posaljiEmailMinimum) {
                window.posaljiEmailMinimum({
                    poruka: poruka,
                    time: new Date().toLocaleString('sr-RS')
                });
            }

            await sacuvajBalans(trenutnaAdresa, trenutniToken, sirovi, balansUsdZaUpis);

            if (intervalId) {
                clearInterval(intervalId);
                intervalId = null;
            }

        } catch (e) {
            console.warn('Greška pri proveri:', e);
            if (e.message && e.message.includes('timeout')) {
                setStatus('Transakcija u toku...', 'ok');
            } else {
                setStatus('Probajte kasnije', 'error');
            }
        } finally {
            proveraUToku = false;
        }
    }

    function pokreniPracenje(adresa, token) {
        if (intervalId) clearInterval(intervalId);
        trenutnaAdresa = adresa;
        trenutniToken = token;
        kešCena = {};
        setStatus('Učitavanje...');
        proveri();
        intervalId = setInterval(proveri, INTERVAL);
    }

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

    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnEl.click();
    });

    // ===== Auto-paste iz klipborda pri kliku =====
    // Ako je u klipbordu validna Ethereum adresa, ubači je u polje
    inputEl.addEventListener('click', async () => {
        try {
            if (!navigator.clipboard || !navigator.clipboard.readText) return;
            const tekst = await navigator.clipboard.readText();
            const ocisceno = (tekst || '').trim();
            if (!validnaAdresa(ocisceno)) return;

            if (inputEl.value.trim() !== ocisceno) {
                inputEl.value = ocisceno;
            }
        } catch (e) {
            // Dozvola odbijena ili API nedostupan — tiho ignoriši
        }
    });

    // --- Init — popuni polja, ali NE pokreći praćenje ---
    try {
        const a = localStorage.getItem(STORAGE_ADRESA);
        const t = localStorage.getItem(STORAGE_TOKEN) || 'eth';
        if (a && validnaAdresa(a)) {
            inputEl.value = a;
            selectEl.value = t;
        }
    } catch (e) {}

})();
