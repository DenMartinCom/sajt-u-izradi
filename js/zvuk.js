
// ===== ZVUK ZA NOVI MINIMUM =====
let audioCtx = null;
let audioUnlocked = false;

// "Otključaj" audio pri prvom kliku korisnika (Chrome policy)
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

// Kratki "ping" zvuk (bez fajlova — Web Audio API)
function playMinimumSound() {
    if (!audioCtx || audioCtx.state !== 'running') return;
    try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);       // A5
        osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.15); // pad na A4
        gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.2);
    } catch (e) {
        console.warn('Zvuk greška:', e);
    }
}
