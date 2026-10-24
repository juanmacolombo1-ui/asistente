// Motor de planificación. Funciones puras: no tocan la pantalla ni la base de datos,
// por eso se pueden probar con node:test.
import { DAY, parseHM, fmtHM, weekday, mondayOf, daysBetween, keyToDate, roundUp, addDays, durationWords } from './time.js';
import { DAY_TYPES } from './defaults.js';

// ---------- Tipo de día y bloques fijos ----------

/** Turno de la semana (de lunes a domingo) que contiene la fecha. */
export function weekShift(date, s) {
  const mon = mondayOf(date);
  if (s.weekShifts && s.weekShifts[mon]) return s.weekShifts[mon];
  if (s.rotation && s.rotation.enabled) {
    const weeks = Math.floor(daysBetween(s.rotation.anchorMonday, mon) / 7);
    const even = ((weeks % 2) + 2) % 2 === 0;
    const other = s.rotation.firstShift === 'manana' ? 'tarde' : 'manana';
    return even ? s.rotation.firstShift : other;
  }
  return 'manana';
}

export function getDayType(date, s) {
  if (s.overrides && s.overrides[date]) return s.overrides[date];
  const wd = weekday(date);
  if (wd === 6 && s.saturdayWithTarde && s.shifts.sabado && weekShift(date, s) === 'tarde') return 'sabado';
  if (!s.workDays.includes(wd)) return 'libre';
  return weekShift(date, s);
}

export const isWorkDay = (t) => t === 'manana' || t === 'tarde' || t === 'sabado';

export function profileFor(dayType, s) {
  return s.profiles[dayType] || s.profiles.libre;
}

export function dayWindow(dayType, s) {
  const p = profileFor(dayType, s);
  const start = parseHM(p.wake);
  let end = parseHM(p.bed);
  if (end <= start) end += DAY;
  return { start, end };
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

export function fixedBlocks(dayType, s) {
  const blocks = [];
  const win = dayWindow(dayType, s);
  if (isWorkDay(dayType)) {
    const sh = s.shifts[dayType];
    const st = parseHM(sh.start);
    const en = parseHM(sh.end);
    const leave = st - s.travelMin;
    if (s.prepMin > 0) {
      blocks.push({ type: 'prep', start: leave - s.prepMin, end: leave, label: 'Prepararte para salir', fixed: true, work: true });
    }
    if (s.travelMin > 0) blocks.push({ type: 'travel', start: leave, end: st, label: 'Viaje al trabajo', fixed: true, work: true });
    blocks.push({ type: 'work', start: st, end: en, label: `Trabajo · ${DAY_TYPES[dayType]}`, fixed: true, work: true });
    if (s.travelMin > 0) blocks.push({ type: 'travel', start: en, end: en + s.travelMin, label: 'Regreso a casa', fixed: true, work: true });
  }
  for (const m of profileFor(dayType, s).meals || []) {
    let ms = parseHM(m.time);
    if (ms == null) continue;
    if (ms < win.start && win.end > DAY) ms += DAY;
    const meal = { type: 'meal', start: ms, end: ms + (Number(m.dur) || 30), label: m.name, fixed: true };
    // Si una comida cae durante el trabajo o el viaje, se come allá: no bloquea la agenda.
    if (blocks.some((b) => b.work && overlaps(b, meal))) continue;
    blocks.push(meal);
  }
  return blocks.sort((a, b) => a.start - b.start);
}

// ---------- Ocurrencias de tareas ----------

export const occKey = (taskId, date) => `${taskId}@${date}`;

function matchDayType(only, dayType) {
  if (!only || only === 'any') return true;
  const dt = dayType === 'vacaciones' ? 'libre' : dayType;
  if (only === 'laboral') return isWorkDay(dt);
  return only === dt;
}

export function occursOn(task, date, dayType) {
  if (task.archived) return false;
  if (!matchDayType(task.onlyDayType, dayType)) return false;
  const r = task.recurrence || { type: 'once' };
  if (r.type === 'once') return task.date === date;
  const start = task.startDate || task.date;
  if (start && date < start) return false;
  if (r.endDate && date > r.endDate) return false;
  const interval = Math.max(1, Number(r.interval) || 1);
  switch (r.type) {
    case 'daily':
    case 'custom':
      return daysBetween(start, date) % interval === 0;
    case 'weekly': {
      if (!(r.days || []).includes(weekday(date))) return false;
      const w = Math.floor(daysBetween(mondayOf(start), mondayOf(date)) / 7);
      return w % interval === 0;
    }
    case 'monthly':
      return keyToDate(date).getDate() === (Number(r.dayOfMonth) || keyToDate(start).getDate());
    default:
      return false;
  }
}

export function instancesForDay(date, state, dayType) {
  const out = [];
  const taskById = new Map(state.tasks.map((t) => [t.id, t]));
  for (const task of state.tasks) {
    if (!occursOn(task, date, dayType)) continue;
    const key = occKey(task.id, date);
    const occ = state.occ[key];
    if (occ && occ.status === 'cancelada') continue;
    if (occ && occ.postponedTo && occ.postponedTo !== date) continue;
    out.push({ key, task, occ: occ || null, date, origin: date });
  }
  // Tareas pospuestas desde otro día hacia esta fecha.
  for (const [key, occ] of Object.entries(state.occ)) {
    const [taskId, origin] = key.split('@');
    const task = taskById.get(taskId);
    if (!task || task.archived) continue;
    if (occ.extra && origin === date) {
      // Tarea que el usuario decidió hacer hoy aunque no le tocaba (ej. «empecé por otra cosa»).
      if (occ.status !== 'cancelada' && !occursOn(task, date, dayType)) out.push({ key, task, occ, date, origin });
      continue;
    }
    if (occ.postponedTo !== date || origin === date) continue;
    if (!['pospuesta', 'en_curso', 'completada', 'pendiente'].includes(occ.status)) continue;
    out.push({ key, task, occ, date, origin });
  }
  return out;
}

export function effectiveDuration(task, occ) {
  return Number((occ && occ.durationOverride) || task.durationMin) || 30;
}

function footprint(task, occ) {
  const dur = effectiveDuration(task, occ);
  const active = task.activeMin && task.activeMin < dur ? task.activeMin : dur;
  return (Number(task.prepMin) || 0) + 2 * (Number(task.travelMin) || 0) + active;
}

/** Tareas únicas vencidas sin resolver: se muestran para decidir, nunca se acumulan solas en la agenda. */
export function pendingDecisions(state, today) {
  const out = [];
  for (const task of state.tasks) {
    if (task.archived || (task.recurrence && task.recurrence.type !== 'once')) continue;
    const key = occKey(task.id, task.date);
    const occ = state.occ[key];
    if (occ && ['completada', 'cancelada'].includes(occ.status)) continue;
    const effective = (occ && occ.postponedTo) || task.date;
    if (effective < today) out.push({ key, task, occ: occ || null, date: effective });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Intervalos libres ----------

function subtract(intervals, cut) {
  const out = [];
  for (const iv of intervals) {
    if (cut.end <= iv.start || cut.start >= iv.end) {
      out.push(iv);
      continue;
    }
    if (cut.start > iv.start) out.push({ start: iv.start, end: cut.start });
    if (cut.end < iv.end) out.push({ start: cut.end, end: iv.end });
  }
  return out;
}

export function freeIntervals(win, blocks, gap, fromMin = null) {
  let free = [{ start: fromMin != null ? Math.max(win.start, fromMin) : win.start, end: win.end }];
  if (free[0].start >= free[0].end) return [];
  for (const b of blocks) {
    if (b.type === 'background' || b.done) continue;
    free = subtract(free, { start: b.start - gap, end: b.end + gap });
  }
  return free.filter((iv) => iv.end - iv.start > 0);
}

const PREF_RANGES = {
  manana: { start: 0, end: 12 * 60 },
  tarde: { start: 12 * 60, end: 19 * 60 },
  noche: { start: 19 * 60, end: 2 * DAY },
};

function findSlot(free, len, earliest, latestEnd, pref) {
  const tryRange = (range) => {
    for (const iv of free) {
      const s = roundUp(Math.max(iv.start, earliest, range ? range.start : -Infinity), 5);
      if (range && s >= range.end) continue;
      if (s + len <= Math.min(iv.end, latestEnd)) return s;
    }
    return null;
  };
  if (pref && PREF_RANGES[pref]) {
    const s = tryRange(PREF_RANGES[pref]);
    if (s != null) return s;
  }
  return tryRange(null);
}

function taskBlock(inst, start, len, extra = {}) {
  const { task, occ } = inst;
  const prep = Number(task.prepMin) || 0;
  const travel = Number(task.travelMin) || 0;
  const taskStart = start + prep + travel;
  const dur = effectiveDuration(task, occ);
  const active = task.activeMin && task.activeMin < dur ? task.activeMin : dur;
  return {
    type: 'task',
    key: inst.key,
    taskId: task.id,
    label: task.name,
    category: task.category,
    priority: task.priority,
    start,
    end: start + (len != null ? len : prep + 2 * travel + active),
    taskStart,
    taskEnd: taskStart + (len != null ? len - prep - 2 * travel : active),
    durationMin: dur,
    status: (occ && occ.status) || 'pendiente',
    fixed: !!task.fixedTime || !!(occ && occ.pinnedStart != null),
    important: !!task.important,
    ...extra,
  };
}

// ---------- Planificación del día ----------

/**
 * Construye la agenda de un día.
 * @param {object} p
 * @param {string} p.date      fecha YYYY-MM-DD
 * @param {object} p.state     estado completo
 * @param {number|null} p.now  minutos actuales si se replanifica el día en curso
 */
export function planDay({ date, state, now = null }) {
  const s = state.settings;
  const dayType = getDayType(date, s);
  const win = dayWindow(dayType, s);
  const blocks = fixedBlocks(dayType, s);
  const unscheduled = [];
  const conflicts = [];
  const gap = Number(s.gapMin) || 0;
  const insts = instancesForDay(date, state, dayType);
  const flex = [];

  const hardBlocks = () => blocks.filter((b) => b.work || (b.type === 'task' && b.fixed));

  for (const inst of insts) {
    const { task, occ } = inst;
    const dur = effectiveDuration(task, occ);
    if (occ && occ.status === 'completada') {
      const start = occ.startMin != null ? occ.startMin : occ.plannedStart;
      if (start != null) {
        blocks.push({ ...taskBlock(inst, start), end: start + (occ.actualMin || dur), done: true, status: 'completada' });
      } else {
        blocks.push({ ...taskBlock(inst, win.start, 0), done: true, status: 'completada', noTime: true });
      }
      continue;
    }
    if (occ && occ.status === 'en_curso' && occ.startMin != null) {
      const len = dur + (Number(occ.extraMin) || 0);
      blocks.push({ ...taskBlock(inst, occ.startMin), start: occ.startMin, end: occ.startMin + len, taskStart: occ.startMin, taskEnd: occ.startMin + len, status: 'en_curso' });
      continue;
    }
    const pinned = occ && occ.pinnedStart != null ? occ.pinnedStart : task.fixedTime ? parseHM(task.fixedTime) : null;
    if (pinned != null) {
      const pre = (Number(task.prepMin) || 0) + (Number(task.travelMin) || 0);
      const b = taskBlock(inst, pinned - pre, null, { fixed: true });
      const clash = hardBlocks().find((h) => overlaps(h, b));
      if (clash || b.start < win.start || b.end > win.end) {
        const reason = clash
          ? `Choca con «${clash.label}» (${fmtHM(clash.start)}–${fmtHM(clash.end)})`
          : `Queda fuera de tu horario despierto (${fmtHM(win.start)}–${fmtHM(win.end)})`;
        conflicts.push({ key: inst.key, task, reason });
        unscheduled.push({ inst, reason, kind: 'conflicto', suggestions: suggestionsFor(inst, date) });
        continue;
      }
      blocks.push(b);
      if (task.activeMin && task.activeMin < dur) blocks.push(backgroundBlock(inst, b, dur));
      continue;
    }
    flex.push(inst);
  }

  // Redondeo hacia abajo: una tarea sin empezar queda «ahora» en vez de correrse siempre al futuro
  const fromMin = now != null ? Math.floor(now / 5) * 5 : null;
  const freeTotal = freeIntervals(win, blocks, gap, fromMin).reduce((a, iv) => a + iv.end - iv.start, 0);
  const budget = Math.floor(freeTotal * (1 - (Number(s.bufferPct) || 0) / 100));
  let used = 0;

  flex.sort((a, b) => {
    const pa = a.task.priority || 2;
    const pb = b.task.priority || 2;
    if (pa !== pb) return pa - pb;
    const da = parseHM(a.task.deadline) ?? 9999;
    const db = parseHM(b.task.deadline) ?? 9999;
    if (da !== db) return da - db;
    return footprint(b.task, b.occ) - footprint(a.task, a.occ);
  });

  const placedEnd = new Map();
  for (const b of blocks) if (b.taskId) placedEnd.set(b.taskId, b.end);
  const todayIds = new Set(insts.map((i) => i.task.id));
  const taskById = new Map(state.tasks.map((t) => [t.id, t]));

  let queue = flex.slice();
  for (let pass = 0; pass < 4 && queue.length; pass++) {
    const deferred = [];
    for (const inst of queue) {
      const { task, occ } = inst;
      let depEnd = -Infinity;
      if (task.dependsOn) {
        const dep = taskById.get(task.dependsOn);
        if (dep && todayIds.has(dep.id)) {
          if (!placedEnd.has(dep.id)) {
            deferred.push(inst);
            continue;
          }
          depEnd = placedEnd.get(dep.id) + gap;
        } else if (dep && dep.recurrence.type === 'once') {
          const depOcc = state.occ[occKey(dep.id, dep.date)];
          if (!depOcc || depOcc.status !== 'completada') {
            unscheduled.push({ inst, kind: 'dependencia', reason: `Primero hay que terminar «${dep.name}»`, suggestions: [] });
            continue;
          }
        }
      }
      const len = footprint(task, occ);
      if (used + len > budget) {
        unscheduled.push({ inst, kind: 'lleno', reason: `El día ya está completo (se reserva un ${s.bufferPct}% de margen)`, suggestions: suggestionsFor(inst, date, blocks) });
        continue;
      }
      const free = freeIntervals(win, blocks, gap, fromMin);
      const earliest = Math.max(win.start, fromMin ?? -Infinity, parseHM(task.earliest) ?? -Infinity, occ && occ.notBefore != null ? occ.notBefore : -Infinity, depEnd);
      const latestEnd = parseHM(task.deadline) ?? win.end;
      const start = findSlot(free, len, earliest, latestEnd, task.preferred);
      if (start != null) {
        const b = taskBlock(inst, start);
        blocks.push(b);
        const dur = effectiveDuration(task, occ);
        if (task.activeMin && task.activeMin < dur) blocks.push(backgroundBlock(inst, b, dur));
        placedEnd.set(task.id, b.end);
        used += len;
        continue;
      }
      if (task.splittable) {
        const parts = splitIntoChunks(inst, free, earliest, latestEnd, Number(task.minChunk) || 25);
        if (parts) {
          parts.forEach((p, i) => blocks.push(taskBlock(inst, p.start, p.len, { part: i + 1, parts: parts.length })));
          placedEnd.set(task.id, parts[parts.length - 1].start + parts[parts.length - 1].len);
          used += len;
          continue;
        }
      }
      const reason = parseHM(task.deadline) != null && earliest + len > latestEnd
        ? `No llega antes de la hora límite (${task.deadline})`
        : 'No hay un hueco libre de ese largo';
      unscheduled.push({ inst, kind: 'no_entra', reason, suggestions: suggestionsFor(inst, date, blocks) });
    }
    if (deferred.length === queue.length) {
      for (const inst of deferred) {
        const dep = taskById.get(inst.task.dependsOn);
        unscheduled.push({ inst, kind: 'dependencia', reason: `Depende de «${dep ? dep.name : '¿?'}», que hoy no entra`, suggestions: suggestionsFor(inst, date) });
      }
      queue = [];
    } else {
      queue = deferred;
    }
  }

  blocks.sort((a, b) => a.start - b.start || (a.type === 'background') - (b.type === 'background'));
  const workBlock = blocks.find((b) => b.type === 'work');
  const leaveBlock = blocks.find((b) => b.type === 'travel' && b.work);
  return {
    date,
    dayType,
    window: win,
    blocks,
    unscheduled,
    conflicts,
    leaveAt: workBlock && leaveBlock ? leaveBlock.start : null,
    freeMin: freeTotal,
    budgetMin: budget,
    plannedFlexMin: used,
  };
}

function backgroundBlock(inst, b, dur) {
  return {
    type: 'background',
    key: inst.key,
    taskId: inst.task.id,
    label: `${inst.task.name} · en marcha`,
    start: b.taskStart,
    end: b.taskStart + dur,
    fixed: false,
  };
}

function splitIntoChunks(inst, free, earliest, latestEnd, minChunk) {
  let remaining = footprint(inst.task, inst.occ);
  const parts = [];
  for (const iv of free) {
    const s = roundUp(Math.max(iv.start, earliest), 5);
    const e = Math.min(iv.end, latestEnd);
    const avail = Math.floor((e - s) / 5) * 5;
    if (avail < minChunk) continue;
    let len = Math.min(avail, remaining);
    if (remaining - len > 0 && remaining - len < minChunk) len = remaining - minChunk; // no dejar restos minúsculos
    if (len < minChunk) continue;
    parts.push({ start: s, len });
    remaining -= len;
    if (remaining <= 0) return parts;
  }
  return null;
}

function suggestionsFor(inst, date, blocks = []) {
  const out = [];
  const dur = effectiveDuration(inst.task, inst.occ);
  if (dur >= 40) out.push({ type: 'reduce', minutes: Math.max(20, roundUp(dur / 2, 5)), label: `Hacer una parte (${Math.max(20, roundUp(dur / 2, 5))} min)` });
  out.push({ type: 'move', to: addDays(date, 1), label: 'Pasarla a mañana' });
  const lower = blocks.filter((b) => b.type === 'task' && !b.fixed && !b.done && b.status === 'pendiente' && (b.priority || 2) > (inst.task.priority || 2));
  if (lower.length) {
    const victim = lower.sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    out.push({ type: 'swap', key: victim.key, label: `Mover «${victim.label}» para hacerle lugar` });
  }
  return out;
}

// ---------- Validación al guardar ----------

/** Devuelve un texto con el conflicto si una tarea con hora fija no es compatible con ese día. */
export function validateFixedTime(task, date, state) {
  if (!task.fixedTime) return null;
  const others = state.tasks.filter((t) => t.id !== task.id);
  const plan = planDay({ date, state: { ...state, tasks: [...others, { ...task, date: task.recurrence.type === 'once' ? date : task.date }] } });
  const c = plan.conflicts.find((x) => x.task.id === task.id);
  if (c) return c.reason;
  const mine = plan.blocks.find((b) => b.taskId === task.id && b.type === 'task');
  if (mine) {
    const other = plan.blocks.find((b) => b !== mine && b.type === 'task' && b.fixed && overlaps(b, mine));
    if (other) return `Se superpone con «${other.label}» (${fmtHM(other.start)}–${fmtHM(other.end)})`;
  }
  return null;
}

// ---------- Ahora / siguiente ----------

export function nowAndNext(plan, nowMin) {
  const tasks = plan.blocks.filter((b) => b.type !== 'background');
  const running = tasks.find((b) => b.type === 'task' && b.status === 'en_curso');
  const current = running || tasks.find((b) => b.start <= nowMin && nowMin < b.end && !b.done);
  const nextTask = plan.blocks.find((b) => b.type === 'task' && !b.done && b.status === 'pendiente' && b.end > nowMin && b !== current);
  const nextCommitment = tasks.find((b) => b.start > nowMin && !b.done && b.type !== 'meal');
  const late = plan.blocks.filter((b) => b.type === 'task' && b.status === 'pendiente' && !b.done && b.start < nowMin - 5 && b !== current);
  return { current, nextTask, nextCommitment, late };
}

/** Compara dos planes y devuelve qué tareas se movieron o quedaron sin lugar. */
export function diffPlans(before, after) {
  const pos = (plan) => new Map(plan.blocks.filter((b) => b.type === 'task' && !b.done).map((b) => [b.key + (b.part || ''), b]));
  const a = pos(before);
  const b = pos(after);
  const moved = [];
  for (const [k, nb] of b) {
    const ob = a.get(k);
    if (ob && ob.start !== nb.start) moved.push({ key: nb.key, label: nb.label, from: ob.start, to: nb.start });
  }
  const beforeUn = new Set(before.unscheduled.map((u) => u.inst.key));
  const dropped = after.unscheduled.filter((u) => !beforeUn.has(u.inst.key));
  return { moved, dropped };
}

// ---------- Textos de voz ----------

const INFINITIVE = /^(\p{L}+(ar|er|ir))(se|la|lo|las|los|le|les)?\b/iu;

export function taskPhrase(name) {
  const n = name.trim();
  if (INFINITIVE.test(n)) return n.charAt(0).toLowerCase() + n.slice(1);
  return `«${n}»`;
}

export function announceStart(block, { project = null, task = null } = {}) {
  const dur = block.durationMin;
  let txt = `Es hora de ${taskPhrase(block.label)}. Tiempo estimado: ${durationWords(dur)}. `;
  txt += `Tu horario programado es de ${fmtHM(block.taskStart)} a ${fmtHM(block.taskStart + dur)}. `;
  if (block.taskStart > block.start) txt += `Contá con salir a las ${fmtHM(block.start + ((task && task.prepMin) || 0))}. `;
  if (project && project.nextStep) txt += `Próximo paso de ${project.name}: ${project.nextStep}. `;
  else if (task && task.steps && task.steps.length) {
    const step = task.steps.find((st) => !st.done);
    if (step) txt += `Primer paso: ${step.text}. `;
  }
  txt += '¿Empezamos?';
  return txt;
}

export function morningBrief(plan, state) {
  const parts = [];
  const dt = plan.dayType;
  if (dt === 'manana') parts.push('Buen día. Hoy trabajás de mañana.');
  else if (dt === 'tarde') parts.push('Buen día. Hoy trabajás de tarde.');
  else if (dt === 'sabado') parts.push(`Buen día. Hoy es sábado de trabajo, de ${fmtHM(parseHM(state.settings.shifts.sabado.start))} a ${fmtHM(parseHM(state.settings.shifts.sabado.end))}.`);
  else if (dt === 'vacaciones') parts.push('Buen día. Hoy estás de vacaciones.');
  else parts.push('Buen día. Hoy tenés el día libre.');
  if (plan.leaveAt != null) parts.push(`Salís a las ${fmtHM(plan.leaveAt)}.`);
  const tasks = plan.blocks.filter((b) => b.type === 'task' && !b.done);
  if (tasks.length) {
    const first = tasks.slice(0, 3).map((b) => `${taskPhrase(b.label)} a las ${fmtHM(b.taskStart)}`);
    parts.push(`Tenés ${tasks.length === 1 ? 'una tarea' : `${tasks.length} tareas`}. Empezás con ${first.join(', después ')}.`);
  } else {
    parts.push('No hay tareas programadas.');
  }
  if (plan.unscheduled.length) parts.push(`Hay ${plan.unscheduled.length === 1 ? 'una tarea que no entra' : `${plan.unscheduled.length} tareas que no entran`}; revisalas cuando puedas.`);
  return parts.join(' ');
}

// ---------- Alarmas del día ----------

export function computeAlarms(plan, settings) {
  const a = settings.alarm;
  const out = [];
  for (const b of plan.blocks) {
    if (b.type === 'prep' && b.work && a.leaveAlert) {
      out.push({ id: `${plan.date}:prep`, at: b.start, kind: 'aviso', title: 'Prepararte para salir', body: `Salís a las ${fmtHM(b.end)} para el trabajo.`, speech: `Empezá a prepararte. Salís a las ${fmtHM(b.end)} para el trabajo.` });
    }
    if (b.type === 'travel' && b.work && b.label === 'Viaje al trabajo' && a.leaveAlert) {
      out.push({ id: `${plan.date}:leave`, at: b.start, kind: 'aviso', title: 'Hora de salir', body: `Entrás a las ${fmtHM(b.end)}.`, speech: `Es hora de salir para el trabajo. Entrás a las ${fmtHM(b.end)}.` });
    }
    if (b.type === 'task' && !b.done && b.status === 'pendiente') {
      const part = b.part ? `-${b.part}` : '';
      if (a.leadMin > 0) {
        out.push({ id: `${b.key}${part}:lead`, at: b.start - a.leadMin, kind: 'previo', key: b.key, title: `En ${a.leadMin} min: ${b.label}`, body: `${fmtHM(b.taskStart)}–${fmtHM(b.taskEnd)}`, speech: `En ${a.leadMin} minutos empieza ${taskPhrase(b.label)}.` });
      }
      out.push({ id: `${b.key}${part}:start`, at: b.start, kind: 'alarma', key: b.key, title: b.label, body: `${fmtHM(b.taskStart)}–${fmtHM(b.taskEnd)} · ${b.durationMin} min`, block: b });
    }
    if (b.type === 'background') {
      out.push({ id: `${b.key}:bg`, at: b.end, kind: 'aviso', key: b.key, title: `Terminó: ${b.label.replace(' · en marcha', '')}`, body: 'Ya podés seguir con el paso siguiente.', speech: `Terminó el ciclo de ${taskPhrase(b.label.replace(' · en marcha', ''))}. Ya podés seguir.` });
    }
  }
  return out.sort((x, y) => x.at - y.at);
}
