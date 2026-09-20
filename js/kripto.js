// ===== KONFIGURACIJA =====
const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
const GAS_UNITS = 95000;
const GWEI_TO_ETH = 1e-9;
const ZAMA_MULTIPLIER = 218;

const GAS_INTERVAL = 12000;
const ZAMA_INTERVAL = GAS_INTERVAL * 5;

// ===== FORMATIRANJE =====
function formatUsd(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatBroj(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    const abs = Math.abs(n);
    let dec;
    if (abs >= 1) dec = 2;
    else if (abs >= 0.01) dec = 4;
    else dec = 6;
    return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

window.formatUsd = formatUsd;
window.formatBroj = formatBroj;

// ===== RATE LIMITER =====
const IZVOR_MIN_RAZMAK = 1000;
const poslednjiPoziv = {
    cmc: 0, gas: 0, fear: 0, coingecko: 0, coinstats: 0,
    balance: 0, 'get-balans': 0, 'save-balans': 0, cena: 0, kurs: 0
};

async function fetchRateLimited(url) {
    let izvor = 'ostalo';
    if (url.includes('/cmc')) izvor = 'cmc';
    else if (url.includes('/gas')) izvor = 'gas';
    else if (url.includes('/fear')) izvor = 'fear';
    else if (url.includes('/coingecko')) izvor = 'coingecko';
    else if (url.includes('/coinstats')) izvor = 'coinstats';
    else if (url.includes('/balance')) izvor = 'balance';
    else if (url.includes('/get-balans')) izvor = 'get-balans';
    else if (url.includes('/save-balans')) izvor = 'save-balans';
    else if (url.includes('/cena')) izvor = 'cena';
    else if (url.includes('/kurs')) izvor = 'kurs';

    const sada = Date.now();
    const proteklo = sada - (poslednjiPoziv[izvor] || 0);
    if (proteklo < IZVOR_MIN_RAZMAK) {
        const čekanje = IZVOR_MIN_RAZMAK - proteklo;
        await new Promise(r => setTimeout(r, čekanje));
    }
    poslednjiPoziv[izvor] = Date.now();

    return fetch(url);
}

window.fetchRateLimited = fetchRateLimited;

// ===== STATUS =====
function setStatus(text, type = 'loading') {
    const el = document.getElementById('status');
    if (!el) return;
    el.className = 'status ' + type;
    document.getElementById('status-text').textContent = text;
}

function resetGasDisplay() {
    ['gas-slow', 'gas-standard', 'gas-slow-usd', 'gas-standard-usd'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = 'N/A';
    });
}

// ===== CMC CENE (podržava i niz i objekat) =====
async function getPricesFromCMC() {
    try {
        const res = await fetchRateLimited(`${WORKER_URL}/cmc`);
        const data = await res.json();

        if (data && data.status && data.status.error_code === '0' && data.data) {
            let eth = null, zama = null, btc = null;

            if (!Array.isArray(data.data) && typeof data.data === 'object') {
                eth  = data.data['1027']  ? parseFloat(data.data['1027'].price)  : null;
                zama = data.data['39332'] ? parseFloat(data.data['39332'].price) : null;
                btc  = data.data['1']     ? parseFloat(data.data['1'].price)     : null;
            } else if (Array.isArray(data.data)) {
                const ethObj  = data.data.find(c => String(c.id) === '1027');
                const zamaObj = data.data.find(c => String(c.id) === '39332');
                const btcObj  = data.data.find(c => String(c.id) === '1');
                eth  = ethObj  ? parseFloat(ethObj.price)  : null;
                zama = zamaObj ? parseFloat(zamaObj.price) : null;
                btc  = btcObj  ? parseFloat(btcObj.price)  : null;
            }

            return { eth, zama, btc };
        }
    } catch (e) {
        console.warn('CMC greška:', e);
    }
    return { eth: null, zama: null, btc: null };
}

// ===== GAS CENA =====
async function getGasPrices() {
    try {
        const res = await fetchRateLimited(`${WORKER_URL}/gas`);
        const data = await res.json();
        if (data.gas && data.gas.status === '1' && data.gas.result) {
            return {
                slow: parseFloat(data.gas.result.SafeGasPrice),
                standard: parseFloat(data.gas.result.ProposeGasPrice)
            };
        }
    } catch (e) {
        console.warn('Gas greška:', e);
    }
    return null;
}

// ===== FEAR & GREED =====
async function getFearGreed() {
    try {
        const res = await fetchRateLimited(`${WORKER_URL}/fear`);
        const data = await res.json();
        if (data && data.data && typeof data.data.value !== 'undefined') {
            return {
                value: parseInt(data.data.value, 10),
                label: data.data.value_classification
            };
        }
    } catch (e) {
        console.warn('Fear&Greed greška:', e);
    }
    return null;
}

function fearColor(v) {
    if (v <= 25) return '#f44336';
    if (v <= 45) return '#ff9800';
    if (v <= 55) return '#FFD700';
    if (v <= 75) return '#8bc34a';
    return '#4caf50';
}

async function loadFearGreed() {
    const fg = await getFearGreed();
    const valEl = document.getElementById('fear-value');
    const arcEl = document.getElementById('fear-arc');
    const labEl = document.getElementById('fear-label');
    if (!valEl || !arcEl || !labEl) return;

    if (!fg) {
        valEl.textContent = '—';
        labEl.textContent = 'Fear & Greed';
        arcEl.style.strokeDashoffset = 264;
        return;
    }

    const v = Math.max(0, Math.min(100, fg.value));
    const circumference = 264;
    const offset = circumference - (circumference * v / 100);

    valEl.textContent = v;
    valEl.style.color = fearColor(v);
    arcEl.style.stroke = fearColor(v);
    arcEl.style.strokeDashoffset = offset;
    labEl.textContent = fg.label || 'Fear & Greed';
}

// ===== GAS WIDGET =====
async function loadGas() {
    setStatus('Učitavanje...', 'loading');

    try {
        const [gas, prices] = await Promise.all([
            getGasPrices(),
            getPricesFromCMC()
        ]);

        const ethPrice = prices.eth;

        if (gas && ethPrice !== null) {
            const slowUsd = gas.slow * GAS_UNITS * GWEI_TO_ETH * ethPrice;
            const standardUsd = gas.standard * GAS_UNITS * GWEI_TO_ETH * ethPrice;
            const ukupno = slowUsd * 3.51;

            document.getElementById('gas-slow').textContent = gas.slow.toFixed(3) + '';
            document.getElementById('gas-standard').textContent = gas.standard.toFixed(3) + '';
            document.getElementById('gas-slow-usd').textContent = '$' + slowUsd.toFixed(3) + ' - Uk. ' + ukupno.toFixed(3);
            document.getElementById('gas-standard-usd').textContent = '$' + standardUsd.toFixed(3);

            if (window.UkChart && typeof window.UkChart.dodajTacku === 'function') {
                window.UkChart.dodajTacku(ukupno);
            }

            setStatus(`Ažurirano • ETH: $${formatUsd(ethPrice)}`, 'ok');
        } else if (gas) {
            document.getElementById('gas-slow').textContent = gas.slow.toFixed(3) + '';
            document.getElementById('gas-standard').textContent = gas.standard.toFixed(3) + '';
            document.getElementById('gas-slow-usd').textContent = '—';
            document.getElementById('gas-standard-usd').textContent = '—';
            setStatus('ETH cena nedostupna', 'error');
        } else {
            resetGasDisplay();
            setStatus('Gas podaci nedostupni', 'error');
        }
    } catch (error) {
        console.error('Greška:', error);
        resetGasDisplay();
        setStatus('Greška pri dobavljanju podataka', 'error');
    }
}

// ===== ZAMA =====
async function loadZama() {
    const prices = await getPricesFromCMC();
    const zamaEl = document.getElementById('zama-result');
    if (!zamaEl) return;

    if (prices.zama !== null && prices.btc !== null) {
        const result = prices.zama * ZAMA_MULTIPLIER;
        const zamaBtc = ((result / prices.btc) * 1000).toFixed(3);
        zamaEl.textContent = zamaBtc + ' 😶‍🌫️ ' + result.toFixed(2);
    } else {
        zamaEl.textContent = '—';
    }
}

// ===== EMAILJS =====
const EMAILJS_SERVICE_ID = 'service_y198bxw';
const EMAILJS_TEMPLATE_ID_GAS = 'template_390r0qq';
const EMAILJS_TEMPLATE_ID_ETH = 'template_z75d21a';
const EMAILJS_PUBLIC_KEY = '27PtNDZ6mWJjgWLil';
const EMAIL_COOLDOWN_MIN = 20;

function initEmailJS() {
    if (window.emailjs) {
        window.emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
        console.log('EmailJS spreman');
        return true;
    }
    return false;
}
if (!initEmailJS()) {
    window.addEventListener('load', initEmailJS);
}

async function emailTreba(tip) {
    try {
        const res = await fetchRateLimited(`${WORKER_URL}/email-treba?tip=${tip}&cooldown=${EMAIL_COOLDOWN_MIN}`);
        const data = await res.json();
        return data;
    } catch (e) {
        console.warn('email-treba greška:', e);
        return { treba: false };
    }
}

async function emailZabelezi(tip) {
    try {
        await fetchRateLimited(`${WORKER_URL}/email-zabelezi?tip=${tip}`);
    } catch (e) {
        console.warn('email-zabelezi greška:', e);
    }
}

async function posaljiEmailMinimum(podaci) {
    if (!window.emailjs) {
        console.warn('EmailJS još nije učitan');
        return;
    }

    const jeGas = (typeof podaci === 'number');

    if (jeGas) {
        const provera = await emailTreba('gas');
        if (!provera.treba) {
            console.log(`Email preskočen — cooldown aktivan (još ${provera.preostalo_min} min)`);
            return;
        }
    }

    let params;
    let templateId;

    if (jeGas) {
        params = {
            value: podaci.toFixed(2),
            time: new Date().toLocaleString('sr-RS')
        };
        templateId = EMAILJS_TEMPLATE_ID_GAS;
    } else {
        params = {
            poruka: podaci.poruka,
            time: podaci.time || new Date().toLocaleString('sr-RS')
        };
        templateId = EMAILJS_TEMPLATE_ID_ETH;
    }

    // Očisti HTML entitete (npr. &#x2F; → /)
    if (params.poruka) {
        params.poruka = params.poruka.replace(/&#x2F;/g, '/').replace(/&#x2f;/g, '/');
    }
    if (params.value && typeof params.value === 'string') {
        params.value = params.value.replace(/&#x2F;/g, '/').replace(/&#x2f;/g, '/');
    }

    try {
        await window.emailjs.send(EMAILJS_SERVICE_ID, templateId, params);
        console.log('Email poslat! (' + (jeGas ? 'gas' : 'adresa') + ')');

        if (jeGas) {
            await emailZabelezi('gas');
        }
    } catch (e) {
        console.warn('Email greška:', e);
    }
}

window.posaljiEmailMinimum = posaljiEmailMinimum;

// ===== INIT =====
loadGas();
loadZama();
loadFearGreed();

setInterval(loadGas, GAS_INTERVAL);
setInterval(loadZama, ZAMA_INTERVAL);