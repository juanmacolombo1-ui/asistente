// Sonidos generados en el momento (sin archivos). Se reproducen con un elemento <audio>,
// que en iPhone usa el canal de reproducción multimedia.

const SR = 22050;

const PATTERNS = {
  campana: { label: 'Campana', notes: [[880, 0, 0.9], [1318.5, 0.25, 1.0], [880, 1.1, 0.9], [1318.5, 1.35, 1.0]], wave: 'bell' },
  digital: { label: 'Digital', notes: [[1000, 0, 0.12], [1000, 0.2, 0.12], [1000, 0.4, 0.12], [1000, 0.8, 0.12], [1000, 1.0, 0.12], [1000, 1.2, 0.12]], wave: 'square' },
  suave: { label: 'Suave', notes: [[523.25, 0, 0.8], [659.25, 0.3, 0.8], [783.99, 0.6, 1.2]], wave: 'sine' },
  urgente: { label: 'Urgente', notes: Array.from({ length: 8 }, (_, i) => [i % 2 ? 1400 : 1050, i * 0.18, 0.15]), wave: 'square' },
};

export const SOUNDS = Object.entries(PATTERNS).map(([id, p]) => ({ id, label: p.label }));

function synth(patternId, volume = 0.9) {
  const p = PATTERNS[patternId] || PATTERNS.campana;
  const total = Math.max(...p.notes.map(([, t, d]) => t + d)) + 0.1;
  const n = Math.floor(total * SR);
  const data = new Float32Array(n);
  for (const [f, t0, dur] of p.notes) {
    const start = Math.floor(t0 * SR);
    const len = Math.floor(dur * SR);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / SR;
      let v;
      if (p.wave === 'bell') {
        const env = Math.exp(-3.2 * t);
        v = env * (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 2.76 * t) + 0.2 * Math.sin(2 * Math.PI * f * 5.4 * t));
      } else if (p.wave === 'square') {
        const env = Math.min(1, i / 200) * Math.min(1, (len - i) / 200);
        v = 0.55 * env * Math.sign(Math.sin(2 * Math.PI * f * t));
      } else {
        const env = Math.min(1, i / 400) * Math.exp(-2.2 * t);
        v = env * Math.sin(2 * Math.PI * f * t);
      }
      data[start + i] += v;
    }
  }
  let peak = 0;
  for (const x of data) peak = Math.max(peak, Math.abs(x));
  const gain = peak ? Math.min(1, volume) / peak : 0;
  // WAV PCM 16 bits mono
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, SR, true); dv.setUint32(28, SR * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i] * gain)) * 32767, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const cache = new Map();
let audioEl = null;
let unlocked = false;

export function isUnlocked() {
  return unlocked;
}

/** Hay que llamarla desde un toque del usuario: iOS no deja reproducir sonido antes. */
export async function unlockAudio() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch { /* no soportado */ }
  audioEl = audioEl || new Audio();
  audioEl.setAttribute('playsinline', '');
  audioEl.src = synth('suave', 0.01);
  try {
    await audioEl.play();
    audioEl.pause();
    unlocked = true;
  } catch {
    unlocked = false;
  }
  return unlocked;
}

export async function playSound(id, volume = 0.9, loops = 1) {
  const k = `${id}:${volume}`;
  if (!cache.has(k)) cache.set(k, synth(id, volume));
  audioEl = audioEl || new Audio();
  audioEl.loop = false;
  for (let i = 0; i < loops; i++) {
    audioEl.src = cache.get(k);
    try {
      await audioEl.play();
      await new Promise((r) => { audioEl.onended = r; setTimeout(r, 4000); });
    } catch {
      return false;
    }
  }
  return true;
}

export function stopSound() {
  if (audioEl) {
    audioEl.pause();
    audioEl.currentTime = 0;
  }
}

export function vibrate(pattern = [400, 200, 400, 200, 800]) {
  if (!('vibrate' in navigator)) return false;
  try {
    return navigator.vibrate(pattern);
  } catch {
    return false;
  }
}

// Mantener la pantalla encendida (bloque de concentración, tarea en curso)
let wakeLock = null;
export async function keepScreenOn(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
      return true;
    }
    if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    return false;
  }
  return !!wakeLock;
}
