// Aprendizaje de duraciones a partir de los tiempos reales registrados.
import { roundUp } from './time.js';

const MAX_LOG = 20;

export function recordActual(state, taskId, date, est, actual) {
  if (!actual || actual <= 0) return;
  const log = (state.durationLog[taskId] = state.durationLog[taskId] || []);
  log.push({ date, est: Math.round(est), actual: Math.round(actual) });
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Sugerencia de duración según los últimos 5 registros (mínimo 3).
 * Devuelve null si no hay datos suficientes o si la diferencia es menor al 10%.
 */
export function suggestDuration(task, log = []) {
  const recent = log.slice(-5).map((x) => x.actual);
  if (recent.length < 3) return null;
  const med = median(recent);
  const suggested = Math.max(5, roundUp(med, 5));
  const dev = (suggested - task.durationMin) / task.durationMin;
  if (Math.abs(dev) < 0.1) return null;
  return { suggested, median: med, samples: recent.length, dev };
}

/**
 * Si el usuario NO fijó la duración a mano, se ajusta sola.
 * Si la fijó, nunca se toca: solo se devuelve la sugerencia para mostrarla.
 */
export function applyLearning(task, log) {
  const sug = suggestDuration(task, log);
  if (!sug) return { changed: false, suggestion: null };
  if (task.durationLocked) return { changed: false, suggestion: sug };
  return { changed: true, from: task.durationMin, to: sug.suggested, suggestion: sug };
}
