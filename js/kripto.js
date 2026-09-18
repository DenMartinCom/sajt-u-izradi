// ===== KONFIGURACIJA =====
const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
const GAS_UNITS = 95000;
const GWEI_TO_ETH = 1e-9;
const ZAMA_MULTIPLIER = 218;

const GAS_INTERVAL = 12000;              // 12 sek
const ZAMA_INTERVAL = GAS_INTERVAL * 5;  // 5x ređe = 60 sek

// Zvuk je u js/zvuk.js — tamo je window.playMinimumSound

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

// ===== DOBAVLJANJE CMC CENA =====
async function getPricesFromCMC() {
    try {
        const res = await fetch(`${WORKER_URL}/cmc`);
        const data = await res.json();

        if (data && data.status && data.status.error_code === '0' && Array.isArray(data.data)) {
            const eth = data.data.find(c => String(c.id) === '1027');
            const zama = data.data.find(c => String(c.id) === '39332');
            const btc = data.data.find(c => String(c.id) === '1');
            return {
                eth: eth ? parseFloat(eth.price) : null,
                zama: zama ? parseFloat(zama.price) : null,
                btc: btc ? parseFloat(btc.price) : null
            };
        }
        console.warn('CMC nije vratio cene:', data);
    } catch (e) {
        console.warn('CMC greška:', e);
    }
    return { eth: null, zama: null, btc: null };
}

// ===== DOBAVLJANJE GAS CENE =====
async function getGasPrices() {
    try {
        const res = await fetch(`${WORKER_URL}/gas`);
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
        const res = await fetch(`${WORKER_URL}/fear`);
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

// ===== GAS + ETH CENA =====
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

            setStatus(`Ažurirano • ETH: $${ethPrice.toFixed(2)}`, 'ok');
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

// ===== EMAILJS SLANJE =====
const EMAILJS_SERVICE_ID = 'service_y198bxw';
const EMAILJS_TEMPLATE_ID_GAS = 'template_390r0qq';   // gas minimum
const EMAILJS_TEMPLATE_ID_ETH = 'template_z75d21a';   // ETH adresa
const EMAILJS_PUBLIC_KEY = '27PtNDZ6mWJjgWLil';
const EMAIL_COOLDOWN = 60 * 15 * 1000; // 15 min ne 1 sat
const EMAIL_TS_KEY = 'email_last_sent_v1';

// Inicijalizuj EmailJS kada se SDK učita (SDK je dodat u HTML preko <script>)
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

// Cooldown timestamp preživljava refresh (localStorage)
function getPoslednjiEmailTs() {
    try {
        const v = localStorage.getItem(EMAIL_TS_KEY);
        return v ? parseInt(v, 10) : 0;
    } catch (e) {
        return 0;
    }
}

function setPoslednjiEmailTs(ts) {
    try {
        localStorage.setItem(EMAIL_TS_KEY, String(ts));
    } catch (e) {}
}

async function posaljiEmailMinimum(podaci) {
    if (!window.emailjs) {
        console.warn('EmailJS još nije učitan');
        return;
    }

    const sada = Date.now();
    const poslednjiEmailTimestamp = getPoslednjiEmailTs();
    if (sada - poslednjiEmailTimestamp < EMAIL_COOLDOWN) {
        const preostalo = Math.ceil((EMAIL_COOLDOWN - (sada - poslednjiEmailTimestamp)) / 60000);
        console.log(`Email preskočen — cooldown aktivan (još ${preostalo} min)`);
        return;
    }

    // Podrška za dva formata:
    // 1. Broj (staro — za gas minimum)
    // 2. Objekat (novo — za adresu)
    let params;
    if (typeof podaci === 'number') {
        params = {
            value: podaci.toFixed(2),
            time: new Date().toLocaleString('sr-RS')
        };
    } else {
        params = {
            sada_tokena: podaci.sada_tokena,
            sada_usd: podaci.sada_usd,
            bilo_tokena: podaci.bilo_tokena,
            bilo_usd: podaci.bilo_usd,
            razlika_usd: podaci.razlika_usd,
            time: new Date().toLocaleString('sr-RS')
        };
    }

    // Izaberi template u zavisnosti od tipa podataka
const templateId = (typeof podaci === 'number')
    ? EMAILJS_TEMPLATE_ID_GAS
    : EMAILJS_TEMPLATE_ID_ETH;

try {
    await window.emailjs.send(EMAILJS_SERVICE_ID, templateId, params);
    setPoslednjiEmailTs(sada);
    console.log('Email poslat! (' + (typeof podaci === 'number' ? 'gas' : 'ETH adresa') + ')');
} catch (e) {
    console.warn('Email greška:', e);
}

// Izloži globalno (grafikon.js poziva)
window.posaljiEmailMinimum = posaljiEmailMinimum;

// ===== INIT =====
loadGas();
loadZama();
loadFearGreed();

setInterval(loadGas, GAS_INTERVAL);
setInterval(loadZama, ZAMA_INTERVAL);
