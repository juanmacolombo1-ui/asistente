// Voz: lectura en voz alta (speechSynthesis) y dictado de comandos (SpeechRecognition).
// La escucha es solo mientras se mantiene apretado/activo el micrófono: no hay escucha
// continua en segundo plano (el navegador no lo permite).

const PREFERRED = ['es-AR', 'es-UY', 'es-419', 'es-US', 'es-MX', 'es-ES'];
let voice = null;

function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  for (const lang of PREFERRED) {
    const v = voices.find((x) => x.lang.replace('_', '-').toLowerCase() === lang.toLowerCase());
    if (v) return v;
  }
  return voices.find((x) => x.lang.toLowerCase().startsWith('es')) || null;
}

export function initVoice() {
  if (!('speechSynthesis' in window)) return;
  voice = pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', () => { voice = pickVoice(); });
}

export function voiceInfo() {
  if (!('speechSynthesis' in window)) return { available: false };
  const v = voice || pickVoice();
  return { available: true, name: v ? `${v.name} (${v.lang})` : 'voz por defecto del sistema', rioplatense: !!v && /es-(AR|UY)/i.test(v.lang) };
}

export function speak(text, { rate = 1 } = {}) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) return resolve(false);
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = (voice && voice.lang) || 'es-AR';
    if (voice) u.voice = voice;
    u.rate = rate;
    u.onend = () => resolve(true);
    u.onerror = () => resolve(false);
    speechSynthesis.speak(u);
    setTimeout(() => resolve(true), 20000);
  });
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

export function recognitionAvailable() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/** Escucha una frase y la devuelve como texto. */
export function listenOnce({ onInterim } = {}) {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return reject(new Error('El reconocimiento de voz no está disponible en este navegador.'));
    const rec = new SR();
    rec.lang = 'es-AR';
    rec.interimResults = !!onInterim;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    let final = '';
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (onInterim) onInterim(final || interim);
    };
    rec.onerror = (ev) => reject(new Error(ev.error === 'not-allowed' ? 'Permiso de micrófono denegado.' : `No te pude escuchar (${ev.error}).`));
    rec.onend = () => resolve(final.trim());
    try {
      rec.start();
    } catch (e) {
      reject(e);
    }
  });
}
