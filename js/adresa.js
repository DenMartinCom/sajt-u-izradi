
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
    let kurs = null;

    const inputEl = document.getElementById('eth-adresa');
    const selectEl = document.getElementById('token-izbor');
    const btnEl = document.getElementById('eth-prati-btn');
    const statusEl = document.getElementById('adresa-status');

    if (!inputEl || !selectEl || !btnEl || !statusEl) return;

    // ===== FORMATIRANJE =====
    const fUsd = (n, dec) => {
        if (typeof n !== 'number' || !isFinite(n)) return '—';
        const d = (typeof dec === 'number') ? dec : (Math.abs(n) < 1 ? 3 : 2);
        return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    };

    const fBroj = (n) => {
        if (typeof n !== 'number' || !isFinite(n)) return '—';
        const abs = Math.abs(n);
        let dec;
        if (abs >= 1) dec = 2;
        else if (abs >= 0.01) dec = 4;
        else dec = 6;
        return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    };

    const fRsd = (n, dec) => {
        if (typeof n !== 'number' || !isFinite(n)) return null;
        const d = (typeof dec === 'number') ? dec : 0;
        return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    };

    function usdUEur(usd) {
        if (!kurs || !kurs.eur_rsd || !kurs.usd_rsd) return null;
        return usd / (kurs.eur_rsd / kurs.usd_rsd);
    }

    function setStatus(text, type = '') {
        statusEl.textContent = text;
        statusEl.className = 'adresa-status' + (type ? ' ' + type : '');
    }

    function vrednostiUTriValute(usd) {
        if (typeof usd !== 'number' || !isFinite(usd)) return '';
        const dec = Math.abs(usd) < 1 ? 3 : 2;
        let tekst = `$${fUsd(usd, dec)}`;
        const eur = usdUEur(usd);
        if (eur !== null) tekst += ` / €${fUsd(eur, dec)}`;
        if (kurs && kurs.usd_rsd) {
            const rsd = usd * kurs.usd_rsd;
            const rsdDec = Math.abs(usd) < 1 ? 3 : 0;
            tekst += ` / ${fRsd(rsd, rsdDec)} RSD`;
        }
        return tekst;
    }

    function validnaAdresa(a) {
        return /^0x[a-fA-F0-9]{40}$/.test(a);
    }

    async function fetchRL(url, opts) {
        const f = window.fetchRateLimited || fetch;
        return f(url, opts);
    }

    async function fetchSaRetry(url, pokusaja = 2, pauzaMs = 500, timeoutMs = 8000) {
        for (let i = 0; i < pokusaja; i++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetchRL(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (!res.ok) {
                    if (i < pokusaja - 1) { await new Promise(r => setTimeout(r, pauzaMs)); continue; }
                    return null;
                }
                const tekst = await res.text();
                try { return JSON.parse(tekst); }
                catch (jsonErr) {
                    if (i < pokusaja - 1) { await new Promise(r => setTimeout(r, pauzaMs)); continue; }
                    return null;
                }
            } catch (e) {
                clearTimeout(timeoutId);
                if (i < pokusaja - 1) { await new Promise(r => setTimeout(r, pauzaMs)); continue; }
                return null;
            }
        }
        return null;
    }

    async function dohvatiBalans(adresa, token) {
        const config = KRIPTO[token];
        if (!config) throw new Error('Nepoznat token');

        let url = `${WORKER_URL}/balance?address=${adresa}`;
        if (config.contract) url += `&contract=${config.contract}`;

        const data = await fetchSaRetry(url);
        if (!data) throw new Error('timeout');
        if (data.status !== '1') throw new Error(data.message || 'Blockscout greška');

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
        } catch (e) {}
        return null;
    }

    async function sacuvajBalans(adresa, token, balans, balansUsd) {
        try {
            let url = `${WORKER_URL}/save-balans?adresa=${adresa}&token=${token}&balans=${encodeURIComponent(balans)}`;
            if (balansUsd !== null && balansUsd !== undefined) url += `&balans_usd=${balansUsd}`;
            await fetchRL(url);
        } catch (e) {}
    }

    async function dohvatiCacheCenu(adresa, token) {
        try {
            const res = await fetchRL(`${WORKER_URL}/get-balans?adresa=${adresa}&token=${token}`);
            if (!res.ok) return null;
            const data = await res.json();
            if (data.ok && data.podaci && data.podaci.balans_usd && data.podaci.balans) {
                const balans = parseFloat(data.podaci.balans) / KRIPTO[token].delilac;
                if (balans > 0) return parseFloat(data.podaci.balans_usd) / balans;
            }
        } catch (e) {}
        return null;
    }

    // ===== CENA PREKO /cena (Worker bira najzdraviji servis) =====
    async function dohvatiCenu(token, adresa) {
        if (kešCena[token] && (Date.now() - kešCena[token].vreme) < CENA_KEŠ_MS) {
            return kešCena[token].vrednost;
        }

        const config = KRIPTO[token];
        const data = await fetchSaRetry(`${WORKER_URL}/cena?ids=${config.coingecko}`);

        if (data && typeof data[config.coingecko] === 'object' && typeof data[config.coingecko].usd === 'number') {
            console.log('✅ Cena preko', data.izvor || 'nepoznat', ':', data[config.coingecko].usd);
            const cena = data[config.coingecko].usd;
            kešCena[token] = { vrednost: cena, vreme: Date.now() };
            return cena;
        }

        // Fallback: D1 cache iz balans_history
        if (adresa) {
            const cacheCena = await dohvatiCacheCenu(adresa, token);
            if (cacheCena !== null) {
                console.log('✅ Cena iz D1 cache-a:', cacheCena);
                kešCena[token] = { vrednost: cacheCena, vreme: Date.now() };
                return cacheCena;
            }
        }

        return null;
    }

    async function proveri() {
        if (!trenutnaAdresa || !trenutniToken) return;
        if (proveraUToku) return;
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
                if (cena === null) cena = await dohvatiCenu(trenutniToken, trenutnaAdresa);

                if (cena === null) {
                    await sacuvajBalans(trenutnaAdresa, trenutniToken, sirovi, null);
                    setStatus(`Pratim • ${fBroj(balans)} ${trenutniToken.toUpperCase()} (cena nedostupna)`, 'ok');
                    return;
                }
                const usd = balans * cena;
                await sacuvajBalans(trenutnaAdresa, trenutniToken, sirovi, usd.toFixed(2));
                setStatus(`Pratim • ${fBroj(balans)} ${trenutniToken.toUpperCase()} (${vrednostiUTriValute(usd)})`, 'ok');
                return;
            }

            // ===== Uporedi =====
            const prethodniSirovi = prethodni.balans;

            if (sirovi === prethodniSirovi) {
                let cena = cenaUsd;
                if (cena === null) cena = await dohvatiCenu(trenutniToken, trenutnaAdresa);
                if (cena !== null && balans > 0) {
                    const usd = balans * cena;
                    setStatus(`Pratim • ${fBroj(balans)} ${trenutniToken.toUpperCase()} (${vrednostiUTriValute(usd)})`, 'ok');
                } else if (balans === 0) {
                    setStatus(`Čekam uplatu ${trenutniToken.toUpperCase()}...`, 'ok');
                } else {
                    setStatus(`Pratim • ${fBroj(balans)} ${trenutniToken.toUpperCase()}`, 'ok');
                }
                return;
            }

            // ===== Promena =====
            const prethodniBalans = parseFloat(prethodniSirovi) / KRIPTO[trenutniToken].delilac;
            const razlika = balans - prethodniBalans;
            const smer = razlika > 0 ? 'Stiglo' : 'Otišlo';

            let cena = cenaUsd;
            if (cena === null) cena = await dohvatiCenu(trenutniToken, trenutnaAdresa);

            let poruka;
            let balansUsdZaUpis = null;

            if (cena === null) {
                poruka = `${smer} ${fBroj(Math.abs(razlika))} ${trenutniToken.toUpperCase()}`;
            } else {
                const razlikaUsd = Math.abs(razlika) * cena;
                poruka = `${smer} ${fBroj(Math.abs(razlika))} ${trenutniToken.toUpperCase()}, oko ${vrednostiUTriValute(razlikaUsd)}`;
                balansUsdZaUpis = (balans * cena).toFixed(2);
            }

            setStatus(poruka, 'ok');
            if (window.playAdresaSound) window.playAdresaSound();
            if (window.posaljiEmailMinimum) {
                window.posaljiEmailMinimum({ poruka: poruka, time: new Date().toLocaleString('sr-RS') });
            }

            await sacuvajBalans(trenutnaAdresa, trenutniToken, sirovi, balansUsdZaUpis);

            if (intervalId) { clearInterval(intervalId); intervalId = null; }

        } catch (e) {
            console.warn('Greška pri proveri:', e);
            if (e.message && e.message.includes('timeout')) setStatus('Transakcija u toku...', 'ok');
            else setStatus('Probajte kasnije', 'error');
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

        (async () => {
            try {
                const res = await fetchRL(`${WORKER_URL}/kurs`);
                if (res.ok) kurs = await res.json();
            } catch (e) {}
        })();

        proveri();
        intervalId = setInterval(proveri, INTERVAL);
    }

    btnEl.addEventListener('click', () => {
        const a = inputEl.value.trim();
        const t = selectEl.value;
        if (!validnaAdresa(a)) { setStatus('Neispravna adresa', 'error'); return; }
        if (!KRIPTO[t]) { setStatus('Nepoznat token', 'error'); return; }
        try {
            localStorage.setItem(STORAGE_ADRESA, a);
            localStorage.setItem(STORAGE_TOKEN, t);
        } catch (e) {}
        pokreniPracenje(a, t);
    });

    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnEl.click(); });

    async function probajAutoPaste() {
        try {
            if (!navigator.clipboard || !navigator.clipboard.readText) return;
            const tekst = await navigator.clipboard.readText();
            const ocisceno = (tekst || '').trim();
            if (!validnaAdresa(ocisceno)) return;
            if (inputEl.value.trim() !== ocisceno) inputEl.value = ocisceno;
        } catch (e) {}
    }
    inputEl.addEventListener('focus', probajAutoPaste);
    inputEl.addEventListener('click', probajAutoPaste);

    try {
        const a = localStorage.getItem(STORAGE_ADRESA);
        const t = localStorage.getItem(STORAGE_TOKEN) || 'eth';
        if (a && validnaAdresa(a)) { inputEl.value = a; selectEl.value = t; }
    } catch (e) {}

})();
