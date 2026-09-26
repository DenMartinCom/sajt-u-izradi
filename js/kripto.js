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

// ===== FORMAT CENE (globalno pravilo za sajt) =====
// Pravilo:
//   a >= 1e12 → "1.23T" (3 sf, sufiks)
//   a >= 1e9  → "1.23B"
//   a >= 1e6  → "1.23M"
//   a >= 1000 → integer sa zapetama (65,123)
//   1 <= a < 1000 → 2 dec (123.46)
//   0.01 <= a < 1 → 4 sf, max 5 dec (0.6543, 0.06543, 0.00654)
//   0.0001 <= a < 0.01 → 5 dec (0.00654, 0.00012)
//   a < 0.0001 → e notacija, 2 dec u mantisi (1.23e-5)
//   n === 0 → "0"
// Bez "$" — dodaje pozivalac.
function ocistiNule(str) {
    if (str.indexOf('.') === -1) return str;
    str = str.replace(/0+$/, '');
    if (str.endsWith('.')) str = str.slice(0, -1);
    return str;
}

function sufiksBroj(a, delilac, oznaka) {
    const v = a / delilac;
    let str;
    if (v >= 100) str = v.toFixed(0);
    else if (v >= 10) str = v.toFixed(1);
    else str = v.toFixed(2);
    str = ocistiNule(str);
    if (!str) str = '0';
    return str + oznaka;
}

function zaokruziMalo(a) {
    const c = Math.floor(Math.log10(a));
    let dec = 3 - c;
    if (dec > 5) dec = 5;
    if (dec < 0) dec = 0;
    return ocistiNule(a.toFixed(dec));
}

function formatCena(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (n === 0) return '0';

    const neg = n < 0;
    const a = Math.abs(n);
    let rez;

    if (a >= 1e12) rez = sufiksBroj(a, 1e12, 'T');
    else if (a >= 1e9) rez = sufiksBroj(a, 1e9, 'B');
    else if (a >= 1e6) rez = sufiksBroj(a, 1e6, 'M');
    else if (a >= 1000) rez = a.toLocaleString('en-US', { maximumFractionDigits: 0 });
    else if (a >= 1) rez = a.toFixed(2);
    else if (a >= 0.01) rez = zaokruziMalo(a);
    else if (a >= 0.0001) rez = ocistiNule(a.toFixed(5));
    else rez = a.toExponential(2);

    return neg ? '-' + rez : rez;
}

// ===== FORMAT PROCENTA (globalno pravilo za sajt) =====
//   |p| < 10  → 2 dec (0.34, 5.68)
//   |p| < 100 → 1 dec (12.3, 45.7)
//   |p| >= 100 → 0 dec, zapete (1,234)
// Uvek znak +/-. Bez "%" — dodaje pozivalac.
function formatProc(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    const a = Math.abs(n);
    const znak = n >= 0 ? '+' : '-';
    let rez;
    if (a >= 100) rez = a.toLocaleString('en-US', { maximumFractionDigits: 0 });
    else if (a >= 10) rez = a.toFixed(1);
    else rez = a.toFixed(2);
    return znak + rez;
}

window.formatCena = formatCena;
window.formatProc = formatProc;

// ===== RATE LIMITER =====
const IZVOR_MIN_RAZMAK = 1000;
const poslednjiPoziv = {
    odrzivost: 0,
    gas: 0,
    fear: 0,
    balance: 0,
    'get-balans': 0,
    'save-balans': 0,
    kurs: 0,
    watchdog: 0
};

async function fetchRateLimited(url) {
    let izvor = 'ostalo';
    if (url.includes('/odrzivost')) izvor = 'odrzivost';
    else if (url.includes('/gas')) izvor = 'gas';
    else if (url.includes('/fear')) izvor = 'fear';
    else if (url.includes('/balance')) izvor = 'balance';
    else if (url.includes('/get-balans')) izvor = 'get-balans';
    else if (url.includes('/save-balans')) izvor = 'save-balans';
    else if (url.includes('/kurs')) izvor = 'kurs';
    else if (url.includes('/watchdog')) izvor = 'watchdog';

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

// ===== GAS EMAIL CHECKBOX =====
const GAS_EMAIL_KEY = 'gas_email_aktivan';

function getEmailAktivan() {
    try {
        return localStorage.getItem(GAS_EMAIL_KEY) === '1';
    } catch (e) { return false; }
}

function setEmailAktivan(aktivan) {
    try {
        localStorage.setItem(GAS_EMAIL_KEY, aktivan ? '1' : '0');
    } catch (e) {}
}

function initEmailCheckbox() {
    const cb = document.getElementById('gas-email-cb');
    if (!cb) return;
    cb.checked = getEmailAktivan();
    cb.addEventListener('change', () => {
        setEmailAktivan(cb.checked);
        console.log('Gas email:', cb.checked ? 'UKLJUČEN' : 'ISKLJUČEN');
    });
}

// ===== CENE PREKO /odrzivost =====
async function getPricesPrekoOdrzivost(cgIds) {
    try {
        const res = await fetchRateLimited(`${WORKER_URL}/odrzivost?ids=${cgIds.join(',')}`);
        const data = await res.json();
        return data;
    } catch (e) {
        console.warn('Održivost greška:', e);
        return {};
    }
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
        const [resGas, prices] = await Promise.all([
            fetchRateLimited(`${WORKER_URL}/gas`),
            getPricesPrekoOdrzivost(['ethereum'])
        ]);

        let gasData = null;
        try { gasData = await resGas.json(); } catch (e) {}

        const ethPrice = prices.ethereum ? prices.ethereum.usd : null;
        const snap = gasData && gasData.snapshot ? gasData.snapshot : null;

        if (!snap) {
            resetGasDisplay();
            azurirajGasNovi(null);
            setStatus('Gas podaci nedostupni', 'error');
            return;
        }

        // Novi widget
        azurirajGasNovi(snap);
        azurirajGasGraf(gasData.history);

        // Stari widget (Safe/Standard + UK)
        if (snap.safeGasPrice != null && ethPrice !== null) {
            const slowUsd = snap.safeGasPrice * GAS_UNITS * GWEI_TO_ETH * ethPrice;
            const standardUsd = snap.proposeGasPrice * GAS_UNITS * GWEI_TO_ETH * ethPrice;
            const ukupno = slowUsd * 3.51;

            document.getElementById('gas-slow').textContent = snap.safeGasPrice.toFixed(3);
            document.getElementById('gas-standard').textContent = snap.proposeGasPrice.toFixed(3);
            document.getElementById('gas-slow-usd').textContent = '$' + slowUsd.toFixed(3) + ' - Uk. ' + ukupno.toFixed(3);
            document.getElementById('gas-standard-usd').textContent = '$' + standardUsd.toFixed(3);

            if (window.UkChart && typeof window.UkChart.dodajTacku === 'function') {
                window.UkChart.dodajTacku(ukupno);
            }

            setStatus(`Ažurirano • ETH: $${formatUsd(ethPrice)}`, 'ok');
        } else if (snap.safeGasPrice != null) {
            document.getElementById('gas-slow').textContent = snap.safeGasPrice.toFixed(3);
            document.getElementById('gas-standard').textContent = snap.proposeGasPrice.toFixed(3);
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
        azurirajGasNovi(null);
        setStatus('Greška pri dobavljanju podataka', 'error');
    }
}
// ===== NOVI GAS WIDGET =====
function azurirajGasNovi(snap) {
    const el = document.getElementById('gas-full-suggest');
    if (!el) return;

    if (!snap) {
        ['gas-full-suggest', 'gas-full-block', 'gas-full-ratio', 'gas-full-ema', 'gas-full-next', 'gas-full-tip', 'gas-full-standard', 'gas-full-fast'].forEach(id => {
            const e = document.getElementById(id);
            if (e) e.textContent = '—';
        });
        return;
    }

    const set = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };

    // 1. Base Fee
    set('gas-full-suggest', snap.suggestBaseFee != null ? snap.suggestBaseFee.toFixed(3) : '—');

    // 2. Blok
    set('gas-full-block', snap.lastBlock ? '#' + snap.lastBlock : '—');

    // 3. Zauzetost + EMA 5
    const poslednji = (Array.isArray(snap.gasUsedRatio) && snap.gasUsedRatio.length)
        ? snap.gasUsedRatio[snap.gasUsedRatio.length - 1]
        : null;
    set('gas-full-ratio', poslednji != null ? (poslednji * 100).toFixed(1) : '—');
    set('gas-full-ema', snap.emaGasUsed5 != null ? (snap.emaGasUsed5 * 100).toFixed(1) : '—');

    // 4. Sledeći blok
    set('gas-full-next', snap.nextBaseFee != null ? snap.nextBaseFee.toFixed(3) : '—');

    // 6. Tip
    set('gas-full-tip', snap.tip != null ? snap.tip.toFixed(3) + ' Gwei' : '—');

    // 7. Standard i Brz
    set('gas-full-standard', snap.proposeGasPrice != null ? snap.proposeGasPrice.toFixed(3) + ' Gwei' : '—');
    set('gas-full-fast', snap.fastGasPrice != null ? snap.fastGasPrice.toFixed(3) + ' Gwei' : '—');
}

// ===== GRAF GAS BASE FEE =====
let gasChart = null;
const gasY = { min: 0, mid: 0.5, max: 1 };

function azurirajGasGraf(history) {
    if (!Array.isArray(history) || !history.length) return;

    const canvas = document.getElementById('gas-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    const labels = history.map(p => {
        const d = new Date(p.t);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    });
    const values = history.map(p => p.b);

    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) { min = min * 0.95; max = max * 1.05; }
    gasY.min = min;
    gasY.max = max;
    gasY.mid = (min + max) / 2;

    if (gasChart) {
        gasChart.data.labels = labels;
        gasChart.data.datasets[0].data = values;
        gasChart.options.scales.y.min = min;
        gasChart.options.scales.y.max = max;
        gasChart.update('none');
        return;
    }

    gasChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                data: values,
                borderColor: '#FFD700',
                backgroundColor: 'rgba(255,215,0,0.10)',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 0,
                tension: 0.3,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => 'Base Fee: ' + Number(ctx.parsed.y).toFixed(3) + ' Gwei'
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: '#888',
                        font: { size: 9 },
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 4
                    }
                },
                y: {
                    grid: { display: false },
                    min: gasY.min,
                    max: gasY.max,
                    afterBuildTicks: (axis) => {
                        axis.ticks = [
                            { value: gasY.min },
                            { value: gasY.mid },
                            { value: gasY.max }
                        ];
                    },
                    ticks: {
                        color: '#FFD700',
                        font: { size: 10 },
                        callback: (v) => Number(v).toFixed(3)
                    }
                }
            }
        }
    });
}

// ===== ZAMA WIDGET =====
async function loadZama() {
    const prices = await getPricesPrekoOdrzivost(['zama', 'bitcoin']);
    const zamaEl = document.getElementById('zama-result');
    if (!zamaEl) return;

    const zamaCena = prices.zama ? prices.zama.usd : null;
    const btcCena = prices.bitcoin ? prices.bitcoin.usd : null;

    if (zamaCena !== null && btcCena !== null) {
        const result = zamaCena * ZAMA_MULTIPLIER;
        const zamaBtc = ((result / btcCena) * 1000).toFixed(3);
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

    // Ako je gas — proveri checkbox; ako nije štiklirano, ne šalji
    if (jeGas && !getEmailAktivan()) {
        console.log('Gas email preskočen — checkbox nije štikliran');
        return;
    }

    // Cooldown samo za gas
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
initEmailCheckbox();
loadGas();
loadZama();
loadFearGreed();

setInterval(loadGas, GAS_INTERVAL);
setInterval(loadZama, ZAMA_INTERVAL);