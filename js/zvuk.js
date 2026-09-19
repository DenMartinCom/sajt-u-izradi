// ===== ZVUK ZA NOVI MINIMUM =====
// Prodorni dvostruki "bip" — Web Audio API, bez fajlova

let audioCtx = null;
let audioUnlocked = false;

// "Otključaj" audio pri prvom kliku korisnika (browser policy)
function unlockAudio() {
    if (audioUnlocked) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        audioUnlocked = true;
    } catch (e) {
        console.warn('Audio nije dostupan:', e);
    }
}
document.addEventListener('click', unlockAudio, { once: true });
document.addEventListener('touchstart', unlockAudio, { once: true });

// Jedan "bip" na zadatoj frekvenciji i vremenu
function bip(freq, startTime, duration, volume) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
}

// Prodorni dvostruki bip — za gas minimum
function playMinimumSound() {
    if (!audioCtx || audioCtx.state !== 'running') return;
    try {
        const t = audioCtx.currentTime;
        bip(1200, t,          0.18, 0.35);
        bip(900,  t + 0.22,   0.22, 0.35);
    } catch (e) {
        console.warn('Zvuk greška:', e);
    }
}

// Kratki "ping" za promenu na adresi — drugačiji od gas minimuma
// Tri kratka tona: 600 → 900 → 1200 Hz (vedriji, brži)
function playAdresaSound() {
    if (!audioCtx || audioCtx.state !== 'running') return;
    try {
        const t = audioCtx.currentTime;
        bip(600,  t,          0.08, 0.25);
        bip(900,  t + 0.10,   0.08, 0.30);
        bip(1200, t + 0.20,   0.12, 0.35);
    } catch (e) {
        console.warn('Zvuk greška:', e);
    }
}

// Izloži globalno
window.playMinimumSound = playMinimumSound;
window.playAdresaSound = playAdresaSound;
