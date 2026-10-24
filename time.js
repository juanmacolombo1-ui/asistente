// Utilidades de fecha y hora. Todo trabaja en hora local del dispositivo.
// Dentro de un día, los horarios se representan como minutos desde la medianoche
// de ese día; pueden superar 1440 (ej. acostarse 00:30 del día siguiente = 1470).

export const DAY = 1440;

export function parseHM(hm) {
  if (hm == null || hm === '') return null;
  if (typeof hm === 'number') return hm;
  const m = /^(\d{1,2}):?(\d{2})$/.exec(String(hm).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function fmtHM(min) {
  const v = ((Math.round(min) % DAY) + DAY) % DAY;
  const h = Math.floor(v / 60);
  const m = v % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function pad(n) {
  return String(n).padStart(2, '0');
}

export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function keyToDate(key, minutes = 0) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 0, minutes, 0, 0);
}

export function addDays(key, n) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

/** 0 = domingo ... 6 = sábado */
export function weekday(key) {
  return keyToDate(key).getDay();
}

export function mondayOf(key) {
  const wd = weekday(key);
  const diff = wd === 0 ? -6 : 1 - wd;
  return addDays(key, diff);
}

export function daysBetween(a, b) {
  const ms = keyToDate(b) - keyToDate(a);
  return Math.round(ms / 86400000);
}

export function minutesNow(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

export function roundUp(min, step = 5) {
  return Math.ceil(min / step) * step;
}

export const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
export const WEEKDAYS_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
export const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function humanDate(key) {
  const d = keyToDate(key);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
}

const NUM_WORDS = ['cero', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte',
  'veintiún', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const TENS = { 30: 'treinta', 40: 'cuarenta', 50: 'cincuenta' };

function numWord(n) {
  if (n < 30) return NUM_WORDS[n];
  const t = Math.floor(n / 10) * 10;
  const u = n % 10;
  return u === 0 ? TENS[t] : `${TENS[t]} y ${u === 1 ? 'un' : NUM_WORDS[u]}`;
}

/** 90 -> "una hora y treinta minutos" (para leer en voz alta) */
export function durationWords(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60);
  const m = min % 60;
  const parts = [];
  if (h === 1) parts.push('una hora');
  else if (h > 1) parts.push(`${numWord(h)} horas`);
  if (m === 1) parts.push('un minuto');
  else if (m > 1) parts.push(`${numWord(m)} minutos`);
  if (!parts.length) return 'cero minutos';
  return parts.join(' y ');
}

/** 90 -> "1 h 30 min" (para mostrar) */
export function durationShort(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  if (!m) return `${h} h`;
  return `${h} h ${m} min`;
}
