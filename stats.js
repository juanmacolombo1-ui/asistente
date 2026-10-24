// Estadísticas y recomendaciones. Muestran tendencias; no puntúan a la persona.
import { planDay, occKey } from './planner.js';
import { addDays, daysBetween, parseHM } from './time.js';
import { suggestDuration } from './learning.js';
import { REASONS } from './defaults.js';

export function rangeFor(kind, today) {
  if (kind === 'dia') return { from: today, to: today };
  if (kind === 'semana') return { from: addDays(today, -6), to: today };
  return { from: addDays(today, -29), to: today };
}

export function computeStats(state, from, to) {
  const days = [];
  const totals = { scheduled: 0, completed: 0, postponed: 0, cancelled: 0, projectMin: 0, focusBlocks: 0, focusMin: 0, restMin: 0, marginMin: 0, interruptions: 0 };
  const reasons = {};
  const postponedByTask = {};
  const n = daysBetween(from, to);
  for (let i = 0; i <= n; i++) {
    const date = addDays(from, i);
    const plan = planDay({ date, state });
    const keys = new Set();
    for (const b of plan.blocks) if (b.type === 'task') keys.add(b.key);
    for (const u of plan.unscheduled) keys.add(u.inst.key);
    const day = { date, dayType: plan.dayType, scheduled: keys.size, completed: 0, postponed: 0 };
    for (const key of keys) {
      const occ = state.occ[key];
      if (occ && occ.status === 'completada') day.completed++;
    }
    // Lo pospuesto o cancelado cuenta en el día original
    for (const [key, occ] of Object.entries(state.occ)) {
      const origin = key.split('@')[1];
      if (origin !== date) continue;
      if (occ.status === 'pospuesta' || occ.postponedTo) {
        day.postponed++;
        const tid = key.split('@')[0];
        postponedByTask[tid] = (postponedByTask[tid] || 0) + 1;
      }
      if (occ.status === 'cancelada') totals.cancelled++;
      if (occ.reason) reasons[occ.reason] = (reasons[occ.reason] || 0) + 1;
    }
    for (const b of plan.blocks) {
      if (b.type === 'task' && b.category === 'descanso') totals.restMin += b.end - b.start;
    }
    totals.marginMin += Math.max(0, plan.freeMin - plan.plannedFlexMin);
    totals.scheduled += day.scheduled;
    totals.completed += day.completed;
    totals.postponed += day.postponed;
    days.push(day);
  }
  for (const f of state.focus) {
    if (f.date < from || f.date > to) continue;
    if (f.completed) totals.focusBlocks++;
    totals.focusMin += f.minutes || 0;
    totals.interruptions += f.interruptions || 0;
    if (f.projectId) totals.projectMin += f.minutes || 0;
  }
  for (const p of state.projects) for (const s of p.sessions) if (s.date >= from && s.date <= to && !s.fromFocus) totals.projectMin += s.minutes || 0;

  const estVsReal = [];
  for (const task of state.tasks) {
    const log = (state.durationLog[task.id] || []).filter((x) => x.date >= from && x.date <= to);
    if (!log.length) continue;
    const avg = Math.round(log.reduce((a, x) => a + x.actual, 0) / log.length);
    estVsReal.push({ task, est: task.durationMin, avg, samples: log.length });
  }
  return { from, to, days, totals, reasons, estVsReal, postponedByTask, recommendations: recommendations(state, days, reasons, postponedByTask) };
}

export function recommendations(state, days, reasons, postponedByTask) {
  const out = [];
  for (const task of state.tasks) {
    const sug = suggestDuration(task, state.durationLog[task.id]);
    if (sug && Math.abs(sug.dev) >= 0.15) {
      out.push({
        type: 'duration', taskId: task.id, value: sug.suggested,
        text: `«${task.name}» te viene llevando unos ${Math.round(sug.median)} min (estimado: ${task.durationMin}). ¿Ajustamos a ${sug.suggested} min?`,
      });
    }
  }
  for (const [tid, count] of Object.entries(postponedByTask)) {
    const task = state.tasks.find((t) => t.id === tid);
    if (task && count >= 3) out.push({ type: 'postponed', taskId: tid, text: `«${task.name}» se pospuso ${count} veces. Probá achicarla, cambiarle el horario o cancelarla.` });
  }
  // Cansancio por franja horaria
  const tiredByPart = { manana: 0, tarde: 0, noche: 0 };
  for (const [key, occ] of Object.entries(state.occ)) {
    if (occ.reason !== 'cansado' || occ.plannedStart == null) continue;
    const m = occ.plannedStart % 1440;
    tiredByPart[m < 720 ? 'manana' : m < 1140 ? 'tarde' : 'noche']++;
    void key;
  }
  const worst = Object.entries(tiredByPart).sort((a, b) => b[1] - a[1])[0];
  if (worst[1] >= 2) out.push({ type: 'tired', text: `Varias tareas de la ${worst[0] === 'manana' ? 'mañana' : worst[0]} quedaron por cansancio. Conviene pasar las más pesadas a otra franja.` });
  if ((reasons.muy_grande || 0) >= 2) out.push({ type: 'big', text: 'Algunas tareas resultaron demasiado grandes. Dividilas en pasos o marcalas como divisibles.' });
  if ((reasons.distraccion || 0) >= 3) out.push({ type: 'focus', text: 'Hubo varias distracciones. Probá iniciar las tareas con un bloque de concentración de 25 minutos y el celular lejos.' });
  const heavy = days.filter((d) => d.scheduled >= 5);
  if (heavy.length >= 2) {
    const ratio = heavy.reduce((a, d) => a + d.completed / d.scheduled, 0) / heavy.length;
    if (ratio < 0.5) out.push({ type: 'load', text: `Los días con 5 o más tareas completás menos de la mitad. Probá planificar 3 o 4 por día.` });
  }
  return out;
}

export function reasonLabel(id) {
  const r = REASONS.find((x) => x.id === id);
  return r ? r.label : id;
}

export { occKey, parseHM };
