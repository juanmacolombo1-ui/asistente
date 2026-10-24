// Asistente personal: interfaz y coordinación.
import { Store, exportJSON, validateImport, migrate } from './store.js';
import { CATEGORIES, PRIORITIES, REASONS, DAY_TYPES, HOME_AREAS, newTask, newProject, homePresets, newId } from './defaults.js';
import {
  planDay, nowAndNext, computeAlarms, announceStart, morningBrief, pendingDecisions, diffPlans,
  validateFixedTime, occKey, getDayType, occursOn, taskPhrase, isWorkDay,
} from './planner.js';
import { parseTaskText, parseCommand, normalize, findTask, splitItems } from './parser.js';
import { recordActual, applyLearning } from './learning.js';
import { computeStats, rangeFor, reasonLabel } from './stats.js';
import { buildICS } from './ics.js';
import {
  dateKey, addDays, fmtHM, parseHM, minutesNow, roundUp, humanDate, durationShort, durationWords,
  mondayOf, WEEKDAYS_SHORT, keyToDate,
} from './time.js';
import { SOUNDS, unlockAudio, isUnlocked, playSound, stopSound, vibrate, keepScreenOn } from './sound.js';
import { initVoice, speak, stopSpeaking, voiceInfo, recognitionAvailable, listenOnce } from './voice.js';

const store = new Store();
let state;
const ui = {
  tab: 'ahora',
  agendaDate: dateKey(),
  agendaMode: 'dia',
  masTab: 'stats',
  statsRange: 'semana',
  lastMinute: -1,
  alarm: null,
  focusTimer: null,
  missed: [],
  dismissed: new Set(),
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => dateKey();
const nowMin = () => minutesNow();
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const cat = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[0];
const taskById = (id) => state.tasks.find((t) => t.id === id);
const projectById = (id) => state.projects.find((p) => p.id === id);
const ensureOcc = (key) => (state.occ[key] = state.occ[key] || { status: 'pendiente' });
// Hoy nunca se ubican tareas flexibles en el pasado; para otros días se planifica el día entero.
const plan = (date = today(), now) => planDay({ date, state, now: now === undefined ? (date === today() ? nowMin() : null) : now });

function save() {
  store.save(state);
}

function commit(msg) {
  save();
  render();
  if (msg) toast(msg);
}

// ---------- Avisos breves ----------

let toastTimer;
function toast(text, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button id="toast-act">${esc(action.label)}</button>` : ''}`;
  el.classList.add('show');
  if (action) $('#toast-act').onclick = () => { el.classList.remove('show'); action.fn(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 7000 : 3500);
}

function say(text) {
  if (state.settings.alarm.voice) speak(text, { rate: state.settings.alarm.voiceRate });
}

// ---------- Hojas inferiores ----------

function openSheet(html, onMount) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="overlay" data-overlay><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
  if (onMount) onMount($('.sheet', root));
}
function closeSheet() {
  $('#sheet-root').innerHTML = '';
}
const sheetOpen = () => !!$('#sheet-root .overlay');

// ---------- Textos auxiliares ----------

function recText(t) {
  const r = t.recurrence || { type: 'once' };
  let s;
  if (r.type === 'once') s = t.date === today() ? 'Hoy' : humanDate(t.date);
  else if (r.type === 'daily') s = r.interval > 1 ? `Cada ${r.interval} días` : 'Todos los días';
  else if (r.type === 'weekly') s = `${r.interval > 1 ? 'Cada 2 semanas' : 'Semanal'}: ${(r.days || []).map((d) => WEEKDAYS_SHORT[d]).join(', ') || '—'}`;
  else if (r.type === 'monthly') s = `Mensual (día ${r.dayOfMonth || keyToDate(t.startDate).getDate()})`;
  else s = `Cada ${r.interval} días`;
  if (t.onlyDayType && t.onlyDayType !== 'any') s += ` · ${{ manana: 'semanas de mañana', tarde: 'semanas de tarde', libre: 'días libres', laboral: 'días de trabajo' }[t.onlyDayType]}`;
  return s;
}

function blockIcon(b) {
  return { work: '💼', travel: '🚌', prep: '🧥', meal: '🍽️', background: '⏳' }[b.type] || cat(b.category).icon;
}

function dayChip(dt) {
  const cls = isWorkDay(dt) ? 'work' : 'ok';
  return `<span class="chip ${cls}">${esc(DAY_TYPES[dt])}</span>`;
}

function liveCountdown(targetMin, prefix = '') {
  return `<span data-countdown="${targetMin}" data-prefix="${esc(prefix)}">${countdownText(targetMin, prefix)}</span>`;
}
function countdownText(targetMin, prefix = '') {
  const diff = targetMin - nowMin();
  if (diff <= 0) return prefix ? `${prefix} ahora` : 'ahora';
  const m = Math.ceil(diff);
  return `${prefix ? prefix + ' ' : ''}${m >= 60 ? durationShort(m) : `${m} min`}`;
}

function nextStepFor(block) {
  const task = taskById(block.taskId);
  if (!task) return null;
  const project = task.projectId ? projectById(task.projectId) : null;
  if (project && project.nextStep) return `Próximo paso: ${project.nextStep}`;
  const occ = state.occ[block.key];
  const doneIdx = (occ && occ.stepsDone) || [];
  const step = task.steps.findIndex((s, i) => !doneIdx.includes(i));
  if (step >= 0) return `Paso ${step + 1}/${task.steps.length}: ${task.steps[step].text}`;
  return null;
}

// ---------- Render general ----------

function render() {
  renderTop();
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  const view = $('#view');
  const fn = { ahora: viewAhora, agenda: viewAgenda, tareas: viewTareas, compras: viewCompras, proyectos: viewProyectos, mas: viewMas }[ui.tab];
  view.innerHTML = fn();
  ui.lastMinute = Math.floor(nowMin());
}

function renderTop() {
  const d = today();
  const dt = getDayType(d, state.settings);
  const date = keyToDate(d);
  $('#topbar').innerHTML = `
    <div class="clock" data-clock>${fmtHM(nowMin())}</div>
    <div class="grow day">${WEEKDAYS_SHORT[date.getDay()]} ${date.getDate()}/${date.getMonth() + 1} · ${esc(DAY_TYPES[dt])}</div>
    <button class="btn sm ghost" data-act="unlock" title="Sonido y voz">${isUnlocked() ? '🔊' : '🔇'}</button>`;
}

// ---------- Ahora ----------

function viewAhora() {
  const d = today();
  const p = plan(d);
  const n = nowMin();
  const nn = nowAndNext(p, n);
  const { current, nextTask, nextCommitment } = nn;
  // Atrasadas: con hora fija ya pasada, o flexibles que sonaron hace más de 15 min y no se empezaron
  const late = [...nn.late, ...p.blocks.filter((b) => b.type === 'task' && b.status === 'pendiente' && !nn.late.includes(b) && state.occ[b.key]?.alarmedAt != null && n - state.occ[b.key].alarmedAt > 15)];
  const out = [];

  if (!isUnlocked()) {
    out.push(`<button class="banner info" style="width:100%;text-align:left;border:0" data-act="unlock">🔇 <span><b>Tocá acá para activar sonido y voz.</b><br><span class="small">El iPhone lo exige cada vez que abrís la app. Sin esto, las alarmas no suenan.</span></span></button>`);
  }
  if (isIOS && !isStandalone() && !ui.dismissed.has('install')) {
    out.push(`<div class="banner info">📲 <span class="grow small"><b>Instalala en la pantalla de inicio</b> para que funcione como app y guarde tus datos de forma estable. En Safari: botón Compartir → «Agregar a pantalla de inicio».</span><button class="btn sm ghost" data-act="dismiss" data-id="install">✕</button></div>`);
  }
  if (ui.missed.length) {
    out.push(`<div class="banner">⏰ <span class="grow small"><b>Mientras la app estaba cerrada pasó la hora de:</b> ${ui.missed.map((a) => esc(a.title)).join(', ')}.</span><button class="btn sm" data-act="replan">Reorganizar</button></div>`);
  }
  const pend = pendingDecisions(state, d);
  if (pend.length) {
    out.push(`<div class="banner">📌 <span class="grow small"><b>${pend.length === 1 ? 'Hay una tarea' : `Hay ${pend.length} tareas`} de días anteriores para decidir.</b></span><button class="btn sm" data-act="decide">Decidir</button></div>`);
  }
  if (late.length && !(current && current.status === 'en_curso')) {
    out.push(`<div class="banner">🕒 <span class="grow small">Te atrasaste con <b>${esc(late[0].label)}</b>. Revisemos la agenda y movamos lo flexible.</span><button class="btn sm" data-act="replan">Reorganizar</button></div>`);
  }
  const firstUse = Math.min(...state.tasks.map((t) => new Date(t.createdAt).getTime() || Date.now()), Date.now());
  const backupDue = state.tasks.length && Date.now() - new Date(state.settings.lastBackupAt || firstUse) > 7 * 864e5;
  if (backupDue && !ui.dismissed.has('backup')) {
    out.push(`<div class="banner info">💾 <span class="grow small">Hace más de una semana que no guardás una copia de tus datos.</span><button class="btn sm" data-act="exportJson">Guardar copia</button><button class="btn sm ghost" data-act="dismiss" data-id="backup">✕</button></div>`);
  }

  out.push(heroCard(p, current, nextTask, late));

  if (nextCommitment && nextCommitment !== current && nextCommitment !== nextTask) {
    out.push(`<div class="card row"><div class="grow"><div class="small muted">Próximo compromiso</div><b>${blockIcon(nextCommitment)} ${esc(nextCommitment.label)}</b> <span class="muted">${fmtHM(nextCommitment.start)}</span></div><b>${liveCountdown(nextCommitment.start, 'en')}</b></div>`);
  }

  out.push(`
    <div class="cmdbar">
      <input type="text" id="cmd" placeholder="Decime: ¿qué sigue?, terminé, agregá…" enterkeyhint="send" autocomplete="off">
      <button class="mic" data-act="listen" aria-label="Hablar">🎙️</button>
    </div>
    <div class="row wrap" style="margin-top:10px">
      <button class="chip" data-act="cmd" data-text="¿Qué sigue?">¿Qué sigue?</button>
      <button class="chip" data-act="cmd" data-text="Reorganizá mi día">Reorganizá mi día</button>
      <button class="chip" data-act="cmd" data-text="Estoy cansado">Estoy cansado</button>
      <button class="chip" data-act="switch">↔ Hacer otra cosa</button>
      <button class="chip" data-act="errand">🏃 Tengo que salir</button>
      <button class="chip" data-act="brief">🔈 Mi día</button>
      <button class="chip" data-act="focus" data-min="${state.settings.focus.defaultMin}">⏱ Concentración</button>
    </div>`);

  const upcoming = p.blocks.filter((b) => b.end > n && b.type !== 'background' && !b.done).slice(0, 7);
  out.push(`<div class="section-title row between"><span>Hoy</span><button class="btn sm ghost" data-act="tab" data-tab="agenda">Ver agenda ›</button></div>`);
  out.push(`<div class="card">${upcoming.length ? agendaList(upcoming, p, n) : '<div class="empty">No queda nada programado hoy.</div>'}
    ${p.unscheduled.length ? `<button class="btn sm" style="margin-top:10px" data-act="tab" data-tab="agenda">⚠️ ${p.unscheduled.length} sin lugar hoy</button>` : ''}</div>`);
  if (!state.tasks.length) {
    out.push(`<div class="card stack"><h3>Primeros pasos</h3><p class="small muted">1) En <b>Más → Ajustes</b> revisá tus turnos y horarios. 2) Cargá tus tareas (podés escribir «Limpiar toda la casa me lleva una hora y media»). 3) Activá el sonido arriba.</p><button class="btn primary" data-act="onboarding">Configurar ahora</button></div>`);
  }
  return out.join('');
}

function heroCard(p, current, nextTask, late) {
  const n = nowMin();
  if (current && current.type === 'task' && current.status === 'en_curso') {
    const occ = state.occ[current.key];
    const end = current.end;
    const total = end - occ.startMin;
    const pct = Math.min(100, Math.max(0, ((n - occ.startMin) / total) * 100));
    const step = nextStepFor(current);
    return `<div class="card hero">
      <div class="label">En curso · ${esc(cat(current.category).label)}</div>
      <div class="title">${esc(current.label)}</div>
      <div class="countdown" data-remaining="${end}">${remainingText(end)}</div>
      <div class="muted small">Empezaste ${fmtHM(occ.startMin)} · estimado ${durationShort(current.durationMin)}${occ.extraMin ? ` (+${occ.extraMin})` : ''}</div>
      <div class="progress"><i data-progress="${occ.startMin},${end}" style="width:${pct}%"></i></div>
      ${step ? `<div class="step">${esc(step)}</div>` : ''}
      ${stepsChecklist(current)}
      <div class="btns">
        <button class="btn ok big full" data-act="done" data-key="${current.key}">${current.category === 'compras' ? '🏠 Volví' : '✓ Terminé'}</button>
        <button class="btn" data-act="more" data-key="${current.key}" data-min="10">+10 min</button>
        <button class="btn" data-act="focus" data-key="${current.key}" data-min="${Math.min(60, Math.max(5, Math.round(end - n)))}">⏱ Concentrarme</button>
        <button class="btn full" data-act="switch" data-key="${current.key}">↔ Cambiar a otra tarea</button>
        ${current.category === 'compras' ? '' : '<button class="btn full" data-act="errand">🏃 Tengo que salir (queda en pausa)</button>'}
        <button class="btn ghost full" data-act="cant" data-key="${current.key}">No puedo seguir ahora</button>
      </div></div>`;
  }
  if (current && current.type !== 'task') {
    return `<div class="card hero">
      <div class="label">Ahora</div>
      <div class="title">${blockIcon(current)} ${esc(current.label)}</div>
      <div class="when">Hasta las ${fmtHM(current.end)} · ${liveCountdown(current.end, 'termina en')}</div>
      ${nextTask ? `<div class="step">Después: <b>${esc(nextTask.label)}</b> a las ${fmtHM(nextTask.taskStart)} (${durationShort(nextTask.durationMin)})</div>` : ''}
    </div>`;
  }
  const t = current && current.type === 'task' ? current : nextTask;
  if (t) {
    const started = t.start <= n;
    const step = nextStepFor(t);
    return `<div class="card hero">
      <div class="label">${started ? 'Ahora te toca' : 'Próxima tarea'} · ${esc(cat(t.category).label)}</div>
      <div class="title">${esc(t.label)}${t.parts ? ` <span class="chip">${t.part}/${t.parts}</span>` : ''}</div>
      <div class="when">${fmtHM(t.taskStart)}–${fmtHM(t.taskEnd)} · ${durationShort(t.durationMin)}</div>
      <div class="muted small">${started ? (late.includes(t) ? `Estaba para las ${fmtHM(t.start)}` : 'Es ahora') : liveCountdown(t.start, 'Empieza en')}${t.taskStart > t.start ? ` · salís ${fmtHM(t.start + (taskById(t.taskId)?.prepMin || 0))}` : ''}</div>
      ${state.occ[t.key]?.paused ? `<div class="step">⏸ La dejaste en pausa: te quedan unos ${Math.max(5, t.durationMin - (state.occ[t.key].elapsedBefore || 0))} min.</div>` : ''}
      ${step ? `<div class="step">${esc(step)}</div>` : ''}
      <div class="btns">
        <button class="btn primary big full" data-act="start" data-key="${t.key}">▶ Empezar</button>
        <button class="btn" data-act="done" data-key="${t.key}">✓ Ya la hice</button>
        <button class="btn" data-act="cant" data-key="${t.key}">No puedo</button>
        <button class="btn full" data-act="switch" data-key="${t.key}">↔ Empecé por otra tarea</button>
        <button class="btn full" data-act="errand">🏃 Tengo que salir</button>
        <button class="btn ghost full" data-act="announce" data-key="${t.key}">🔈 Escuchar</button>
      </div></div>`;
  }
  return `<div class="card hero"><div class="label">Ahora</div><div class="title">Nada pendiente 🎉</div>
    <div class="muted">Es tiempo libre. Descansá o agregá algo si querés.</div>
    <div class="btns"><button class="btn" data-act="tab" data-tab="tareas">+ Agregar tarea</button><button class="btn" data-act="focus" data-min="${state.settings.focus.defaultMin}">⏱ Concentración</button></div></div>`;
}

function stepsChecklist(block) {
  const task = taskById(block.taskId);
  if (task && task.category === 'compras') return shopChecklist(block);
  if (!task || !task.steps.length) return '';
  const occ = state.occ[block.key] || {};
  const done = occ.stepsDone || [];
  return `<ul class="list" style="margin-top:8px">${task.steps.map((s, i) => `
    <li><label class="row grow"><input type="checkbox" data-act="step" data-key="${block.key}" data-i="${i}" ${done.includes(i) ? 'checked' : ''}> <span class="${done.includes(i) ? 'muted' : ''}">${esc(s.text)}</span></label></li>`).join('')}</ul>`;
}

function remainingText(endMin) {
  const diff = endMin - nowMin();
  const sign = diff < 0 ? '+' : '';
  const a = Math.abs(diff);
  const m = Math.floor(a);
  const s = Math.floor((a - m) * 60);
  return `${sign}${m}:${String(s).padStart(2, '0')}`;
}

function agendaList(blocks, p, n = null) {
  return `<ul class="agenda">${blocks.map((b) => {
    const cls = [b.type === 'task' ? 'taskrow' : '', b.fixed && b.type !== 'task' ? 'fixed' : '', b.type, b.done ? 'done' : '',
      b.type === 'background' ? 'bg' : '', n != null && b.start <= n && n < b.end && !b.done && b.type !== 'background' ? 'now' : '',
      n != null && b.type === 'task' && b.status === 'pendiente' && b.start < n - 5 && p.date === today() ? 'late' : ''].join(' ');
    const meta = [];
    if (b.type === 'task') {
      meta.push(durationShort(b.durationMin));
      if (b.taskStart > b.start) meta.push(`incluye traslado`);
      if (b.status === 'en_curso') meta.push('en curso');
      if (b.fixed) meta.push('hora fija');
      if (b.parts) meta.push(`parte ${b.part} de ${b.parts}`);
    }
    return `<li class="${cls}" ${b.type === 'task' ? `data-act="blockMenu" data-key="${b.key}"` : ''}>
      <div class="t">${b.noTime ? '—' : fmtHM(b.start)}<small>${b.noTime ? '' : fmtHM(b.end)}</small></div>
      <div><div class="what">${blockIcon(b)} ${esc(b.label)}</div>${meta.length ? `<div class="meta">${esc(meta.join(' · '))}</div>` : ''}</div></li>`;
  }).join('')}</ul>`;
}

// ---------- Agenda ----------

function viewAgenda() {
  const d = ui.agendaDate;
  const out = [`<div class="row between">
    <button class="btn sm" data-act="agendaNav" data-n="${ui.agendaMode === 'dia' ? -1 : -7}">‹</button>
    <div style="text-align:center"><b>${ui.agendaMode === 'dia' ? esc(humanDate(d)) : `Semana del ${keyToDate(mondayOf(d)).getDate()}/${keyToDate(mondayOf(d)).getMonth() + 1}`}</b>
      ${d !== today() ? '<br><button class="btn sm ghost" data-act="agendaToday">Ir a hoy</button>' : ''}</div>
    <button class="btn sm" data-act="agendaNav" data-n="${ui.agendaMode === 'dia' ? 1 : 7}">›</button></div>
    <div class="row" style="margin:12px 0">
      <button class="chip ${ui.agendaMode === 'dia' ? 'on' : ''}" data-act="agendaMode" data-mode="dia">Día</button>
      <button class="chip ${ui.agendaMode === 'semana' ? 'on' : ''}" data-act="agendaMode" data-mode="semana">Semana</button>
    </div>`];
  if (ui.agendaMode === 'semana') return out.join('') + weekView(d);
  const p = plan(d);
  const n = d === today() ? nowMin() : null;
  out.push(`<div class="card"><div class="row between wrap">${dayChip(p.dayType)}
      <button class="btn sm" data-act="dayType" data-date="${d}">Cambiar este día</button></div>
      ${p.leaveAt != null ? `<p class="small muted" style="margin:10px 0 0">Salís ${fmtHM(p.leaveAt)} · volvés ${fmtHM(p.blocks.find((b) => b.label === 'Regreso a casa')?.end ?? 0)}</p>` : ''}
      <p class="small muted" style="margin:6px 0 0">Planificado ${durationShort(p.plannedFlexMin)} de ${durationShort(p.freeMin)} libres (margen ${state.settings.bufferPct}%)</p></div>`);
  out.push(`<div class="card">${p.blocks.length ? agendaList(p.blocks, p, n) : '<div class="empty">Sin actividades.</div>'}</div>`);
  if (p.unscheduled.length) {
    out.push(`<div class="section-title">Sin lugar este día</div><div class="card"><ul class="list">${p.unscheduled.map((u) => `
      <li style="display:block"><div class="name">${esc(u.inst.task.name)}</div><div class="small muted">${esc(u.reason)}</div>
      <div class="row wrap" style="margin-top:8px">${u.suggestions.map((s, i) => `<button class="btn sm" data-act="suggest" data-key="${u.inst.key}" data-date="${d}" data-i="${i}">${esc(s.label)}</button>`).join('')}
      <button class="btn sm ghost" data-act="editTask" data-id="${u.inst.task.id}">Editar</button></div></li>`).join('')}</ul></div>`);
  }
  out.push(`<div class="btns">
    ${d === today() ? '<button class="btn" data-act="replan">↻ Reorganizar</button>' : '<span></span>'}
    <button class="btn" data-act="ics" data-from="${d}" data-days="1">📅 Al Calendario</button>
    <button class="btn ghost full" data-act="briefDay" data-date="${d}">🔈 Escuchar el resumen</button></div>`);
  return out.join('');
}

function weekView(d) {
  const mon = mondayOf(d);
  const s = state.settings;
  const cur = s.weekShifts[mon] || getDayType(mon, { ...s, overrides: {}, workDays: [1, 2, 3, 4, 5, 6, 0] });
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(mon, i);
    const p = plan(date);
    const tasks = p.blocks.filter((b) => b.type === 'task');
    const pct = p.freeMin ? Math.round((p.plannedFlexMin / p.freeMin) * 100) : 0;
    rows.push(`<button data-act="gotoDay" data-date="${date}" class="${date === today() ? 'today' : ''}">
      <div><b>${WEEKDAYS_SHORT[keyToDate(date).getDay()]}</b><div class="tiny muted">${keyToDate(date).getDate()}/${keyToDate(date).getMonth() + 1}</div></div>
      <div><div class="small">${esc(DAY_TYPES[p.dayType])} · ${tasks.length} tareas${p.unscheduled.length ? ` · <span style="color:var(--warn)">${p.unscheduled.length} sin lugar</span>` : ''}</div>
      <div class="bar" style="margin-top:6px"><i style="width:${pct}%"></i></div></div><span class="muted">›</span></button>`);
  }
  return `<div class="card"><div class="small muted">Turno de esta semana</div>
    <div class="row" style="margin-top:8px">
      <button class="chip ${cur === 'manana' ? 'on' : ''}" data-act="weekShift" data-mon="${mon}" data-shift="manana">☀️ Mañana</button>
      <button class="chip ${cur === 'tarde' ? 'on' : ''}" data-act="weekShift" data-mon="${mon}" data-shift="tarde">🌙 Tarde</button>
    </div><p class="tiny muted" style="margin:8px 0 0">${s.rotation.enabled ? 'Las semanas se alternan solas; elegir acá fija esta semana.' : 'Rotación automática apagada.'}</p></div>
    <div class="week" style="margin-top:14px">${rows.join('')}</div>
    <div class="btns"><button class="btn full" data-act="ics" data-from="${mon}" data-days="7">📅 Agregar la semana al Calendario</button></div>`;
}

// ---------- Tareas ----------

function viewTareas() {
  const out = [`<div class="card">
    <div class="small muted" style="margin-bottom:8px">Escribí o dictá la tarea como te salga</div>
    <div class="quickadd"><input type="text" id="qa" placeholder="Ej: Limpiar toda la casa me lleva una hora y media" autocomplete="off" enterkeyhint="done">
    <button class="mic" data-act="listenAdd" aria-label="Dictar">🎙️</button></div>
    <div id="qa-preview"></div>
    <div class="btns"><button class="btn primary" data-act="quickAdd">Agregar</button><button class="btn" data-act="editTask">Formulario completo</button></div></div>`];
  const active = state.tasks.filter((t) => !t.archived && !t.adhoc);
  if (!active.some((t) => t.category === 'hogar')) {
    out.push(`<div class="banner info" style="margin-top:14px">🏠 <span class="grow small">¿Cargamos las tareas de hogar sugeridas (limpieza, gatos, ropa, compras, placares)? Después ajustás las duraciones.</span><button class="btn sm" data-act="homePresets">Cargar</button></div>`);
  }
  if (!active.length) {
    out.push('<div class="empty">Todavía no hay tareas.</div>');
    return out.join('');
  }
  for (const c of CATEGORIES) {
    const list = active.filter((t) => t.category === c.id);
    if (!list.length) continue;
    out.push(`<div class="section-title">${c.icon} ${esc(c.label)} · ${list.length}</div><div class="card"><ul class="list">${list
      .sort((a, b) => (a.area || '').localeCompare(b.area || '') || a.name.localeCompare(b.name))
      .map((t) => `<li data-act="editTask" data-id="${t.id}" style="cursor:pointer"><div class="grow"><div class="name">${esc(t.name)}</div>
      <div class="small muted">${durationShort(t.durationMin)}${t.durationLocked ? ' 🔒' : ''}${t.activeMin ? ` (activo ${t.activeMin})` : ''} · ${esc(recText(t))}${t.fixedTime ? ` · ${t.fixedTime}` : ''}${t.area && c.id === 'hogar' ? ` · ${esc(t.area)}` : ''}</div></div>
      ${t.priority === 1 ? '<span class="chip accent">Alta</span>' : ''}<span class="muted">›</span></li>`).join('')}</ul></div>`);
  }
  const archived = state.tasks.filter((t) => t.archived).length;
  if (archived) out.push(`<p class="small muted" style="text-align:center;margin-top:16px">${archived} tareas archivadas</p>`);
  return out.join('');
}

function taskForm(t) {
  const r = t.recurrence;
  const otherTasks = state.tasks.filter((x) => x.id !== t.id && !x.archived);
  return `<h2>${t.name ? 'Editar tarea' : 'Nueva tarea'}</h2>
  <form id="taskForm" autocomplete="off">
    <label class="field"><span>Nombre</span><input type="text" name="name" value="${esc(t.name)}" required></label>
    <div class="grid2">
      <label class="field"><span>Categoría</span><select name="category">${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === t.category ? 'selected' : ''}>${c.icon} ${esc(c.label)}</option>`).join('')}</select></label>
      <label class="field"><span>Prioridad</span><select name="priority">${PRIORITIES.map((p) => `<option value="${p.id}" ${p.id === t.priority ? 'selected' : ''}>${p.label}</option>`).join('')}</select></label>
    </div>
    <label class="field" data-show="hogar"><span>Área del hogar</span><select name="area"><option value="">—</option>${HOME_AREAS.map((a) => `<option ${a === t.area ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
    <label class="field" data-show="proyecto"><span>Proyecto</span><select name="projectId"><option value="">—</option>${state.projects.map((p) => `<option value="${p.id}" ${p.id === t.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <div class="grid2">
      <label class="field"><span>Duración (min)</span><input type="number" name="durationMin" min="5" max="720" step="5" value="${t.durationMin}" inputmode="numeric"></label>
      <label class="field"><span>Trabajo activo (min)</span><input type="number" name="activeMin" min="0" step="5" value="${t.activeMin || ''}" placeholder="igual" inputmode="numeric"></label>
    </div>
    <div class="switch"><span class="small">La duración la fijé yo (no ajustarla sola)</span><input type="checkbox" name="durationLocked" ${t.durationLocked ? 'checked' : ''}></div>
    <label class="field"><span>Frecuencia</span><select name="recType">
      ${[['once', 'Una vez'], ['daily', 'Todos los días'], ['weekly', 'Semanal'], ['monthly', 'Mensual'], ['custom', 'Cada N días']].map(([v, l]) => `<option value="${v}" ${r.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="field" data-rec="once"><span>Fecha</span><input type="date" name="date" value="${t.date}"></label>
    <div class="field" data-rec="weekly"><span class="small muted" style="font-weight:600">Días</span><div class="days" style="margin-top:6px">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" data-day="${d}" class="${(r.days || []).includes(d) ? 'on' : ''}">${WEEKDAYS_SHORT[d]}</button>`).join('')}</div></div>
    <label class="field" data-rec="monthly"><span>Día del mes</span><input type="number" name="dayOfMonth" min="1" max="31" value="${r.dayOfMonth || keyToDate(t.startDate).getDate()}"></label>
    <label class="field" data-rec="custom daily weekly"><span>Repetir cada (días / semanas)</span><input type="number" name="interval" min="1" max="30" value="${r.interval || 1}"></label>
    <label class="field" data-rec="daily weekly monthly custom"><span>Desde</span><input type="date" name="startDate" value="${t.startDate}"></label>
    <label class="field"><span>Solo en</span><select name="onlyDayType">${[['any', 'Cualquier día'], ['manana', 'Semanas de turno mañana'], ['tarde', 'Semanas de turno tarde'], ['laboral', 'Días de trabajo'], ['libre', 'Días libres']].map(([v, l]) => `<option value="${v}" ${t.onlyDayType === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="grid2">
      <label class="field"><span>Hora fija (opcional)</span><input type="time" name="fixedTime" value="${t.fixedTime || ''}"></label>
      <label class="field"><span>Franja preferida</span><select name="preferred">${[['', 'Cualquiera'], ['manana', 'Mañana'], ['tarde', 'Tarde'], ['noche', 'Noche']].map(([v, l]) => `<option value="${v}" ${(t.preferred || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field"><span>No antes de</span><input type="time" name="earliest" value="${t.earliest || ''}"></label>
      <label class="field"><span>Hora límite</span><input type="time" name="deadline" value="${t.deadline || ''}"></label>
      <label class="field"><span>Preparación (min)</span><input type="number" name="prepMin" min="0" step="5" value="${t.prepMin || 0}"></label>
      <label class="field"><span>Traslado por tramo (min)</span><input type="number" name="travelMin" min="0" step="5" value="${t.travelMin || 0}"></label>
    </div>
    <label class="field"><span>Pasos (uno por línea)</span><textarea name="steps" placeholder="Juntar ropa&#10;Barrer&#10;Trapo">${esc(t.steps.map((s) => s.text).join('\n'))}</textarea></label>
    <div class="switch"><span class="small">Se puede dividir en bloques si no entra entera</span><input type="checkbox" name="splittable" ${t.splittable ? 'checked' : ''}></div>
    <div class="switch"><span class="small">Compromiso importante</span><input type="checkbox" name="important" ${t.important ? 'checked' : ''}></div>
    <label class="field"><span>Depende de</span><select name="dependsOn"><option value="">Ninguna</option>${otherTasks.map((x) => `<option value="${x.id}" ${x.id === t.dependsOn ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Notas</span><textarea name="notes">${esc(t.notes)}</textarea></label>
    <div id="formError"></div>
    <div class="btns">
      <button type="submit" class="btn primary full">Guardar</button>
      ${state.tasks.some((x) => x.id === t.id) ? `<button type="button" class="btn" data-act="archiveTask" data-id="${t.id}">Archivar</button><button type="button" class="btn danger" data-act="deleteTask" data-id="${t.id}">Eliminar</button>` : ''}
      <button type="button" class="btn ghost full" data-act="closeSheet">Cancelar</button>
    </div>
  </form>`;
}

function openTaskForm(task) {
  const t = task || newTask({ date: today(), startDate: today() });
  openSheet(taskForm(t), (sheet) => {
    const form = $('#taskForm', sheet);
    const sync = () => {
      const type = form.recType.value;
      $$('[data-rec]', form).forEach((el) => el.classList.toggle('hidden', !el.dataset.rec.split(' ').includes(type)));
      $$('[data-show]', form).forEach((el) => el.classList.toggle('hidden', el.dataset.show !== form.category.value));
    };
    sync();
    form.addEventListener('change', sync);
    $$('.days button', form).forEach((b) => b.addEventListener('click', () => b.classList.toggle('on')));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = form.elements;
      const num = (v) => (v === '' || v == null ? null : Number(v));
      const updated = {
        ...t,
        name: f.name.value.trim() || 'Tarea',
        category: f.category.value,
        priority: Number(f.priority.value),
        area: f.area.value || null,
        projectId: f.projectId.value || null,
        durationMin: Math.max(5, num(f.durationMin.value) || 30),
        activeMin: num(f.activeMin.value) || null,
        durationLocked: f.durationLocked.checked,
        recurrence: {
          type: f.recType.value,
          days: $$('.days button.on', form).map((b) => Number(b.dataset.day)),
          interval: Math.max(1, num(f.interval.value) || 1),
          dayOfMonth: num(f.dayOfMonth.value),
        },
        date: f.date.value || today(),
        startDate: f.startDate.value || today(),
        onlyDayType: f.onlyDayType.value,
        fixedTime: f.fixedTime.value || null,
        preferred: f.preferred.value || null,
        earliest: f.earliest.value || null,
        deadline: f.deadline.value || null,
        prepMin: num(f.prepMin.value) || 0,
        travelMin: num(f.travelMin.value) || 0,
        steps: f.steps.value.split('\n').map((s) => s.trim()).filter(Boolean).map((text) => ({ text })),
        splittable: f.splittable.checked,
        important: f.important.checked,
        dependsOn: f.dependsOn.value || null,
        notes: f.notes.value,
      };
      if (updated.activeMin && updated.activeMin >= updated.durationMin) updated.activeMin = null;
      if (updated.recurrence.type === 'weekly' && !updated.recurrence.days.length) {
        $('#formError', form).innerHTML = '<div class="banner">Elegí al menos un día de la semana.</div>';
        return;
      }
      const conflict = firstConflict(updated);
      if (conflict) {
        $('#formError', form).innerHTML = `<div class="banner">⛔ <span class="small"><b>No se puede programar así el ${esc(humanDate(conflict.date))}:</b> ${esc(conflict.reason)}. Cambiá la hora o limitá la tarea a otro tipo de día.</span></div>`;
        $('#formError', form).scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      const i = state.tasks.findIndex((x) => x.id === updated.id);
      if (i >= 0) state.tasks[i] = updated;
      else state.tasks.push(updated);
      closeSheet();
      commit(i >= 0 ? 'Tarea actualizada' : `Agregada: ${updated.name}`);
    });
  });
}

/** Revisa las próximas 4 semanas buscando un choque de horario fijo. */
function firstConflict(task) {
  if (!task.fixedTime) return null;
  const s = state.settings;
  for (let i = 0; i < 28; i++) {
    const date = addDays(today(), i);
    if (task.recurrence.type === 'once' && date !== task.date) continue;
    if (!occursOn(task, date, getDayType(date, s))) continue;
    const reason = validateFixedTime(task, date, state);
    if (reason) return { date, reason };
    if (task.recurrence.type === 'once') break;
  }
  return null;
}

function previewQuick(text) {
  const el = $('#qa-preview');
  if (!el) return;
  if (!text.trim()) {
    el.innerHTML = '';
    return;
  }
  const p = parseTaskText(text, today());
  const chips = [`${cat(p.category || 'hogar').icon} ${esc(p.name)}`];
  if (p.durationMin) chips.push(`⏱ ${durationShort(p.durationMin)}${p.durationLocked ? ' (tu dato)' : ''}`);
  if (p.fixedTime) chips.push(`🕒 ${p.fixedTime}`);
  if (p.date) chips.push(`📅 ${humanDate(p.date)}`);
  if (p.recurrence) chips.push(`🔁 ${recText({ ...newTask(), recurrence: p.recurrence })}`);
  if (p.preferred) chips.push(`Franja: ${p.preferred === 'manana' ? 'mañana' : p.preferred}`);
  if (p.priority === 1) chips.push('Alta');
  el.innerHTML = `<div class="row wrap" style="margin-top:10px">${chips.map((c) => `<span class="chip">${c}</span>`).join('')}</div>`;
}

function taskFromText(text) {
  const p = parseTaskText(text, today());
  const base = { date: today(), startDate: today() };
  return newTask({ ...base, ...Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'raw')), startDate: p.date || today() });
}

function addFromText(text, confirm = true) {
  if (!text.trim()) return;
  const t = taskFromText(text);
  const conflict = firstConflict(t);
  if (conflict || confirm === 'form') {
    openTaskForm(t);
    if (conflict) setTimeout(() => { const e = $('#formError'); if (e) e.innerHTML = `<div class="banner">⛔ <span class="small">${esc(conflict.reason)} (${esc(humanDate(conflict.date))}). Elegí otro horario.</span></div>`; }, 50);
    return;
  }
  state.tasks.push(t);
  commit(`Agregada: ${t.name} · ${durationShort(t.durationMin)}`);
  say(`Listo. Agregué ${taskPhrase(t.name)}, ${durationWords(t.durationMin)}.`);
}

// ---------- Proyectos ----------

function viewProyectos() {
  const max = state.settings.projects.maxActive;
  const active = state.projects.filter((p) => p.active);
  const main = state.projects.find((p) => p.main && p.active);
  const out = [];
  if (main) {
    const done = main.tasks.filter((t) => t.done).length;
    const pct = main.tasks.length ? Math.round((done / main.tasks.length) * 100) : 0;
    const mins = main.sessions.reduce((a, s) => a + (s.minutes || 0), 0);
    out.push(`<div class="card hero"><div class="label">Proyecto principal</div><div class="title">${esc(main.name)}</div>
      ${main.objective ? `<div class="muted small">🎯 ${esc(main.objective)}</div>` : ''}
      <div class="step"><b>Próximo paso:</b> ${main.nextStep ? esc(main.nextStep) : '<span class="muted">definilo para que cada sesión arranque directo</span>'}</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="small muted" style="margin-top:6px">${done}/${main.tasks.length} tareas · ${durationShort(mins)} trabajados${main.targetDate ? ` · objetivo ${humanDate(main.targetDate)}` : ''}</div>
      <div class="btns"><button class="btn primary" data-act="focus" data-project="${main.id}" data-min="${state.settings.focus.defaultMin}">⏱ Sesión de ${state.settings.focus.defaultMin} min</button>
      <button class="btn" data-act="editProject" data-id="${main.id}">Abrir</button></div></div>`);
  }
  out.push(`<div class="section-title">Activos · ${active.length}/${max}</div>`);
  const others = state.projects.filter((p) => !p.main || !p.active);
  out.push(`<div class="card">${others.length ? `<ul class="list">${others.map((p) => `<li data-act="editProject" data-id="${p.id}" style="cursor:pointer">
    <div class="grow"><div class="name">${esc(p.name)}</div><div class="small muted">${p.active ? 'Activo' : 'En pausa'}${p.nextStep ? ` · ${esc(p.nextStep)}` : ''}</div></div><span class="muted">›</span></li>`).join('')}</ul>` : `<div class="empty small">${main ? 'No hay otros proyectos.' : 'Todavía no hay proyectos.'}</div>`}
    <button class="btn" style="width:100%;margin-top:10px" data-act="editProject">+ Nuevo proyecto</button></div>`);
  out.push(`<p class="small muted" style="margin:14px 4px">Para terminar proyectos en vez de empezar muchos, como máximo ${max} activos a la vez (se cambia en Ajustes). Al empezar cada sesión ves solo el próximo paso concreto.</p>`);
  return out.join('');
}

function openProjectForm(p) {
  const isNew = !p;
  p = p || newProject();
  const blockTask = state.tasks.find((t) => t.projectId === p.id && !t.archived);
  openSheet(`<h2>${isNew ? 'Nuevo proyecto' : esc(p.name)}</h2>
    <form id="projForm" autocomplete="off">
      <label class="field"><span>Nombre</span><input type="text" name="name" value="${esc(p.name)}" required></label>
      <label class="field"><span>Objetivo concreto</span><input type="text" name="objective" value="${esc(p.objective)}" placeholder="Ej: bot operando en simulación con gestión de riesgo"></label>
      <label class="field"><span>Próximo paso (concreto, de una sesión)</span><textarea name="nextStep" placeholder="Ej: revisar y probar la función de gestión de riesgo">${esc(p.nextStep)}</textarea></label>
      <label class="field"><span>Fecha objetivo (opcional)</span><input type="date" name="targetDate" value="${p.targetDate || ''}"></label>
      <div class="switch"><span>Proyecto principal</span><input type="checkbox" name="main" ${p.main ? 'checked' : ''}></div>
      <div class="switch"><span>Activo</span><input type="checkbox" name="active" ${p.active ? 'checked' : ''}></div>
      <div class="section-title">Tareas del proyecto</div>
      <ul class="list" id="ptasks">${p.tasks.map((t) => `<li><label class="row grow"><input type="checkbox" data-ptask="${t.id}" ${t.done ? 'checked' : ''}> <span>${esc(t.text)}</span></label><button type="button" class="btn sm ghost" data-ptaskdel="${t.id}">✕</button></li>`).join('')}</ul>
      <div class="quickadd" style="margin-top:8px"><input type="text" id="ptaskNew" placeholder="Agregar tarea del proyecto"><button type="button" class="btn" id="ptaskAdd">+</button></div>
      ${p.sessions.length ? `<div class="section-title">Últimas sesiones</div><ul class="list">${p.sessions.slice(-5).reverse().map((s) => `<li class="small"><span class="grow">${esc(humanDate(s.date))}${s.note ? ` · ${esc(s.note)}` : ''}</span><b>${s.minutes} min</b></li>`).join('')}</ul>` : ''}
      <div id="projErr"></div>
      <div class="btns">
        <button type="submit" class="btn primary full">Guardar</button>
        ${!isNew ? `<button type="button" class="btn" data-act="projectBlock" data-id="${p.id}">${blockTask ? 'Ver bloque en agenda' : '+ Bloque diario en agenda'}</button>
        <button type="button" class="btn danger" data-act="deleteProject" data-id="${p.id}">Eliminar</button>` : ''}
        <button type="button" class="btn ghost full" data-act="closeSheet">Cancelar</button>
      </div></form>`, (sheet) => {
    const form = $('#projForm', sheet);
    const tasks = p.tasks.map((t) => ({ ...t }));
    const redraw = () => {
      $('#ptasks', form).innerHTML = tasks.map((t) => `<li><label class="row grow"><input type="checkbox" data-ptask="${t.id}" ${t.done ? 'checked' : ''}> <span>${esc(t.text)}</span></label><button type="button" class="btn sm ghost" data-ptaskdel="${t.id}">✕</button></li>`).join('');
    };
    form.addEventListener('click', (e) => {
      const del = e.target.closest('[data-ptaskdel]');
      if (del) {
        tasks.splice(tasks.findIndex((t) => t.id === del.dataset.ptaskdel), 1);
        redraw();
      }
    });
    form.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-ptask]');
      if (cb) tasks.find((t) => t.id === cb.dataset.ptask).done = cb.checked;
    });
    $('#ptaskAdd', form).onclick = () => {
      const v = $('#ptaskNew', form).value.trim();
      if (!v) return;
      tasks.push({ id: newId(), text: v, done: false });
      $('#ptaskNew', form).value = '';
      redraw();
    };
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = form.elements;
      const upd = { ...p, name: f.name.value.trim() || 'Proyecto', objective: f.objective.value.trim(), nextStep: f.nextStep.value.trim(), targetDate: f.targetDate.value || null, main: f.main.checked, active: f.active.checked, tasks };
      const othersActive = state.projects.filter((x) => x.active && x.id !== p.id).length;
      if (upd.active && othersActive >= state.settings.projects.maxActive) {
        $('#projErr', form).innerHTML = `<div class="banner">Ya tenés ${othersActive} proyectos activos (máximo ${state.settings.projects.maxActive}). Pausá uno antes de activar otro: así se terminan.</div>`;
        return;
      }
      if (upd.main) state.projects.forEach((x) => { x.main = false; });
      const i = state.projects.findIndex((x) => x.id === p.id);
      if (i >= 0) state.projects[i] = upd;
      else state.projects.push(upd);
      closeSheet();
      commit('Proyecto guardado');
    });
  });
}

// ---------- Más: estadísticas, ajustes, respaldo, permisos ----------

function viewMas() {
  const tabs = [['stats', 'Estadísticas'], ['ajustes', 'Ajustes'], ['respaldo', 'Respaldo'], ['permisos', 'Permisos y límites']];
  const head = `<div class="row wrap" style="margin-bottom:12px">${tabs.map(([id, l]) => `<button class="chip ${ui.masTab === id ? 'on' : ''}" data-act="masTab" data-id="${id}">${l}</button>`).join('')}</div>`;
  const body = { stats: viewStats, ajustes: viewAjustes, respaldo: viewRespaldo, permisos: viewPermisos }[ui.masTab]();
  return head + body;
}

function viewStats() {
  const { from, to } = rangeFor(ui.statsRange, today());
  const s = computeStats(state, from, to);
  const t = s.totals;
  const daysHtml = s.days.map((d) => {
    const h = d.scheduled ? Math.round((d.completed / d.scheduled) * 100) : 0;
    return `<div title="${d.date}: ${d.completed}/${d.scheduled}"><i style="height:${h}%"></i></div>`;
  }).join('');
  return `<div class="row" style="margin-bottom:12px">${[['dia', 'Hoy'], ['semana', '7 días'], ['mes', '30 días']].map(([id, l]) => `<button class="chip ${ui.statsRange === id ? 'on' : ''}" data-act="statsRange" data-id="${id}">${l}</button>`).join('')}</div>
    <div class="stats">
      <div class="stat"><b>${t.scheduled}</b><span>Programadas</span></div>
      <div class="stat"><b>${t.completed}</b><span>Completadas</span></div>
      <div class="stat"><b>${t.postponed}</b><span>Pospuestas</span></div>
      <div class="stat"><b>${durationShort(t.projectMin)}</b><span>En proyectos</span></div>
      <div class="stat"><b>${t.focusBlocks}</b><span>Bloques de concentración${t.interruptions ? ` · ${t.interruptions} interrupciones` : ''}</span></div>
      <div class="stat"><b>${durationShort(t.restMin + t.marginMin)}</b><span>Descanso y tiempo libre planificado</span></div>
    </div>
    ${s.days.length > 1 ? `<div class="card" style="margin-top:14px"><h3>Constancia</h3><div class="small muted">Completadas sobre programadas, por día</div><div class="spark">${daysHtml}</div></div>` : ''}
    <div class="section-title">Recomendaciones</div>
    <div class="card">${s.recommendations.length ? `<ul class="list">${s.recommendations.map((r) => `<li style="display:block"><div class="small">${esc(r.text)}</div>
      ${r.type === 'duration' ? `<button class="btn sm" style="margin-top:8px" data-act="applyDuration" data-id="${r.taskId}" data-val="${r.value}">Ajustar a ${r.value} min</button>` : ''}
      ${r.type === 'postponed' ? `<button class="btn sm" style="margin-top:8px" data-act="editTask" data-id="${r.taskId}">Revisar tarea</button>` : ''}</li>`).join('')}</ul>` : '<div class="small muted">Todavía no hay datos suficientes. Al terminar las tareas, registrá cuánto tardaste.</div>'}</div>
    ${s.estVsReal.length ? `<div class="section-title">Estimado vs. real</div><div class="card"><ul class="list">${s.estVsReal.map((x) => `<li class="small"><span class="grow">${esc(x.task.name)}</span><span>${x.est} → <b>${x.avg} min</b> <span class="muted">(${x.samples})</span></span></li>`).join('')}</ul></div>` : ''}
    ${Object.keys(s.reasons).length ? `<div class="section-title">Por qué quedaron tareas sin hacer</div><div class="card"><ul class="list">${Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<li class="small"><span class="grow">${esc(reasonLabel(k))}</span><b>${v}</b></li>`).join('')}</ul></div>` : ''}
    <p class="tiny muted" style="margin:14px 4px">No hay puntaje de productividad: los números sirven para ajustar el plan, no para medirte.</p>`;
}

function num(path, label, attrs = '') {
  return `<label class="field"><span>${label}</span><input type="number" data-set="${path}" value="${esc(getPath(state.settings, path))}" inputmode="numeric" ${attrs}></label>`;
}
function time(path, label) {
  return `<label class="field"><span>${label}</span><input type="time" data-set="${path}" value="${esc(getPath(state.settings, path))}"></label>`;
}
function toggle(path, label) {
  return `<div class="switch"><span>${label}</span><input type="checkbox" data-set="${path}" ${getPath(state.settings, path) ? 'checked' : ''}></div>`;
}
function getPath(o, path) {
  return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
}
function setPath(o, path, v) {
  const ks = path.split('.');
  const last = ks.pop();
  const tgt = ks.reduce((a, k) => a[k], o);
  tgt[last] = v;
}

function viewAjustes() {
  const s = state.settings;
  const mon = mondayOf(today());
  const nextMon = addDays(mon, 7);
  const shiftOf = (m) => getDayType(m, { ...s, overrides: {}, workDays: [1] });
  const overrides = Object.entries(s.overrides).filter(([d]) => d >= today()).sort();
  const profile = (id, label) => `<details class="acc"><summary>${label}</summary>
    <div class="grid2">${time(`profiles.${id}.wake`, 'Me levanto')}${time(`profiles.${id}.bed`, 'Me acuesto')}</div>
    ${s.profiles[id].meals.map((m, i) => `<div class="grid3">
      <label class="field"><span>Comida</span><input type="text" data-set="profiles.${id}.meals.${i}.name" value="${esc(m.name)}"></label>
      ${time(`profiles.${id}.meals.${i}.time`, 'Hora')}${num(`profiles.${id}.meals.${i}.dur`, 'Min')}</div>`).join('')}</details>`;
  return `
  <details class="acc" open><summary>Turnos y semanas</summary>
    <div class="small muted">Esta semana (desde el ${keyToDate(mon).getDate()}/${keyToDate(mon).getMonth() + 1})</div>
    <div class="row" style="margin:8px 0 12px">${['manana', 'tarde'].map((x) => `<button class="chip ${shiftOf(mon) === x ? 'on' : ''}" data-act="weekShift" data-mon="${mon}" data-shift="${x}">${DAY_TYPES[x]}</button>`).join('')}</div>
    <div class="small muted">Semana que viene</div>
    <div class="row" style="margin:8px 0 4px">${['manana', 'tarde'].map((x) => `<button class="chip ${shiftOf(nextMon) === x ? 'on' : ''}" data-act="weekShift" data-mon="${nextMon}" data-shift="${x}">${DAY_TYPES[x]}</button>`).join('')}</div>
    ${toggle('rotation.enabled', 'Alternar turnos automáticamente cada semana')}
    <div class="grid2">${time('shifts.manana.start', 'Mañana: entrada')}${time('shifts.manana.end', 'Mañana: salida')}${time('shifts.tarde.start', 'Tarde: entrada')}${time('shifts.tarde.end', 'Tarde: salida')}</div>
    ${toggle('saturdayWithTarde', 'En semanas de turno tarde también trabajo el sábado')}
    <div class="grid2">${time('shifts.sabado.start', 'Sábado: entrada')}${time('shifts.sabado.end', 'Sábado: salida')}</div>
    <div class="grid2">${num('travelMin', 'Viaje por tramo (min)')}${num('prepMin', 'Prepararme para salir (min)')}</div>
    <div class="field"><span class="small muted" style="font-weight:600">Días que trabajo</span><div class="days" style="margin-top:6px">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button data-act="workDay" data-day="${d}" class="${s.workDays.includes(d) ? 'on' : ''}">${WEEKDAYS_SHORT[d]}</button>`).join('')}</div></div>
  </details>
  <details class="acc"><summary>Días libres, vacaciones y excepciones</summary>
    <div class="grid2"><label class="field"><span>Desde</span><input type="date" id="ovFrom" value="${today()}"></label><label class="field"><span>Hasta</span><input type="date" id="ovTo" value="${today()}"></label></div>
    <label class="field"><span>Tipo</span><select id="ovType">${Object.entries(DAY_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
    <button class="btn" style="width:100%;margin-top:10px" data-act="addOverride">Agregar excepción</button>
    ${overrides.length ? `<ul class="list" style="margin-top:8px">${overrides.map(([d, t]) => `<li class="small"><span class="grow">${esc(humanDate(d))}: <b>${DAY_TYPES[t]}</b></span><button class="btn sm ghost" data-act="delOverride" data-date="${d}">✕</button></li>`).join('')}</ul>` : ''}
  </details>
  ${profile('manana', 'Sueño y comidas · semana de mañana')}
  ${profile('tarde', 'Sueño y comidas · semana de tarde')}
  ${profile('sabado', 'Sueño y comidas · sábado de trabajo')}
  ${profile('libre', 'Sueño y comidas · días libres')}
  <details class="acc"><summary>Planificación</summary>
    <div class="grid2">${num('bufferPct', 'Margen libre (%)', 'min="0" max="60"')}${num('gapMin', 'Separación entre tareas (min)', 'min="0" max="60"')}</div>
    <p class="tiny muted">El margen es la parte del tiempo libre que nunca se llena, para imprevistos, tráfico y descansos.</p>
  </details>
  <details class="acc"><summary>Alarmas y voz</summary>
    <div class="grid3">${num('alarm.leadMin', 'Aviso previo (min)')}${num('alarm.repeatEveryMin', 'Repetir cada (min)')}${num('alarm.maxRepeats', 'Máx. repeticiones', 'min="0" max="10"')}</div>
    <label class="field"><span>Sonido</span><select data-set="alarm.sound">${SOUNDS.map((x) => `<option value="${x.id}" ${s.alarm.sound === x.id ? 'selected' : ''}>${x.label}</option>`).join('')}</select></label>
    <label class="field"><span>Volumen</span><input type="range" min="0.1" max="1" step="0.1" data-set="alarm.volume" value="${s.alarm.volume}" style="width:100%"></label>
    ${toggle('alarm.vibrate', 'Vibrar (si el dispositivo lo permite)')}
    ${toggle('alarm.voice', 'Anunciar en voz alta')}
    <label class="field"><span>Velocidad de la voz</span><input type="range" min="0.7" max="1.3" step="0.05" data-set="alarm.voiceRate" value="${s.alarm.voiceRate}" style="width:100%"></label>
    ${toggle('alarm.leaveAlert', 'Avisarme cuándo prepararme y salir al trabajo')}
    <div class="btns"><button class="btn" data-act="testSound">🔔 Probar sonido</button><button class="btn" data-act="testAlarm">⏰ Probar alarma</button></div>
  </details>
  <details class="acc"><summary>Concentración y proyectos</summary>
    <label class="field"><span>Bloque de concentración por defecto</span><select data-set="focus.defaultMin">${[25, 45, 60].map((m) => `<option value="${m}" ${s.focus.defaultMin === m ? 'selected' : ''}>${m} minutos</option>`).join('')}</select></label>
    ${num('focus.breakMin', 'Pausa después del bloque (min)')}
    ${num('projects.maxActive', 'Proyectos activos a la vez (máx.)', 'min="1" max="5"')}
  </details>`;
}

function viewRespaldo() {
  const last = state.settings.lastBackupAt ? new Date(state.settings.lastBackupAt).toLocaleString('es-AR') : 'nunca';
  return `<div class="card stack">
    <h3>Tus datos</h3>
    <p class="small muted">Se guardan solo en este teléfono (no se suben a ningún servidor). La app guarda copias automáticas internas, pero si borrás los datos de Safari o la app, se pierden: exportá una copia cada tanto.</p>
    <p class="small">Última copia exportada: <b>${esc(last)}</b> · ${state.tasks.length} tareas · ${state.projects.length} proyectos</p>
    <button class="btn primary" style="width:100%" data-act="exportJson">💾 Exportar copia (archivo .json)</button>
    <label class="btn" style="width:100%">📂 Importar copia<input type="file" accept="application/json,.json" id="importFile" hidden></label>
    <button class="btn" style="width:100%" data-act="snapshots">🕘 Restaurar una copia automática</button>
  </div>
  <div class="card stack"><h3>Zona delicada</h3><button class="btn danger" style="width:100%" data-act="resetAll">Borrar todos los datos</button></div>`;
}

function viewPermisos() {
  const v = voiceInfo();
  const notif = 'Notification' in window ? Notification.permission : 'no disponible';
  const caps = [
    [isStandalone() ? '✅' : '⚠️', `<b>Instalada como app:</b> ${isStandalone() ? 'sí' : 'no. En iPhone: Safari → Compartir → «Agregar a pantalla de inicio».'}`],
    [isUnlocked() ? '✅' : '⚠️', `<b>Sonido:</b> ${isUnlocked() ? 'activado en esta sesión' : 'tocá 🔇 arriba para activarlo (iOS lo pide cada vez que se abre la app)'}.`],
    [v.available ? '✅' : '❌', `<b>Voz:</b> ${v.available ? esc(v.name) + (v.rioplatense ? '' : '. Tu iPhone no trae voz rioplatense: se usa otra voz en español; las frases sí están en rioplatense.') : 'no disponible'}`],
    [recognitionAvailable() ? '✅' : '⚠️', `<b>Comandos por voz:</b> ${recognitionAvailable() ? 'disponible con el botón 🎙️ (escucha solo mientras está activo)' : 'el navegador no lo ofrece acá. Usá el dictado del teclado (el micrófono del teclado del iPhone) en el cuadro de texto.'}`],
    ['Notification' in window && notif === 'granted' ? '✅' : '⚠️', `<b>Notificaciones:</b> ${esc(notif)}. ${'Notification' in window && notif !== 'granted' ? '<button class="btn sm" data-act="askNotif">Pedir permiso</button>' : ''}`],
    ['wakeLock' in navigator ? '✅' : '⚠️', `<b>Pantalla encendida:</b> ${'wakeLock' in navigator ? 'disponible durante tareas y bloques de concentración' : 'no disponible'}.`],
    ['vibrate' in navigator ? '✅' : '❌', `<b>Vibración:</b> ${'vibrate' in navigator ? 'disponible' : 'Safari en iPhone no permite que las web apps vibren.'}`],
  ];
  return `<div class="card">${caps.map(([i, t]) => `<div class="cap"><span>${i}</span><span>${t}</span></div>`).join('')}</div>
  <div class="section-title">Límites reales de una web app en iPhone</div>
  <div class="card small stack">
    <p><b>Con la app abierta y en pantalla</b>, la alarma suena, habla y muestra los botones. Usá «Mantener pantalla encendida» en tareas largas.</p>
    <p><b>Con el iPhone bloqueado o la app cerrada, la web app NO puede hacer sonar alarmas</b>: iOS no permite que una web app programe avisos locales. Por eso existe <b>«📅 Al Calendario»</b>: exporta la agenda con alarmas al Calendario del iPhone, que sí suena bloqueado.</p>
    <p>El Calendario respeta el modo silencio y los modos de concentración del iPhone. Para que te avise igual, permití «Calendario» en Ajustes → Concentración.</p>
    <p>Si cambiás la agenda después de exportar, el Calendario no se actualiza solo: volvé a exportar ese día (iOS puede duplicar eventos; borrá el anterior).</p>
    <p>No hay bloqueo de otras apps: Safari no lo permite. Para eso usá «Tiempo en pantalla» del iPhone; la app registra cuándo salís de ella durante un bloque de concentración.</p>
  </div>`;
}

// ---------- Acciones ----------

function isTest(key) {
  if (key !== 'prueba@x') return false;
  closeAlarm();
  closeSheet();
  toast('Fin de la prueba de alarma.');
  return true;
}

function startTask(key) {
  if (isTest(key)) return;
  const p = plan();
  for (const [k, o] of Object.entries(state.occ)) {
    if (o.status === 'en_curso' && k !== key) {
      o.status = 'pendiente';
      o.elapsedBefore = (o.elapsedBefore || 0) + Math.max(0, Math.round(nowMin() - (o.startMin ?? nowMin()))); // recordar lo avanzado
      delete o.startMin;
    }
  }
  const b = p.blocks.find((x) => x.key === key && x.type === 'task');
  const occ = ensureOcc(key);
  occ.status = 'en_curso';
  occ.startMin = Math.floor(nowMin());
  occ.startedAt = new Date().toISOString();
  occ.plannedStart = b ? b.start : occ.startMin;
  occ.extraMin = 0;
  occ.paused = false;
  occ.resumeFirst = false;
  closeAlarm();
  keepScreenOn(true);
  commit();
  const task = taskById(key.split('@')[0]);
  const step = b ? nextStepFor(b) : null;
  say(`Arrancamos con ${taskPhrase(task.name)}. Tenés ${durationWords(task.durationMin)}.${step ? ' ' + step + '.' : ''}`);
}

function openDoneSheet(key) {
  const [taskId] = key.split('@');
  const task = taskById(taskId);
  const occ = ensureOcc(key);
  const est = (occ.durationOverride || task.durationMin);
  const actual = occ.startMin != null && occ.status === 'en_curso' ? Math.max(1, Math.round(nowMin() - occ.startMin + (occ.elapsedBefore || 0))) : est;
  const project = task.projectId ? projectById(task.projectId) : null;
  openSheet(`<h2>¡Terminaste! 👏</h2><p class="muted">${esc(task.name)}</p>
    <label class="field"><span>¿Cuánto tardaste? (min) — opcional</span><input type="number" id="actualMin" value="${actual}" min="1" inputmode="numeric"></label>
    <div class="row wrap" style="margin-top:8px">${[-10, -5, 5, 10].map((d) => `<button class="chip" data-adj="${d}">${d > 0 ? '+' : ''}${d}</button>`).join('')}</div>
    ${project ? `<label class="field"><span>Próximo paso de «${esc(project.name)}»</span><textarea id="nextStep">${esc(project.nextStep)}</textarea></label>` : ''}
    <div class="btns"><button class="btn primary" data-act="saveDone" data-key="${key}">Guardar</button><button class="btn" data-act="saveDone" data-key="${key}" data-skip="1">Sin registrar tiempo</button></div>`, (sheet) => {
    $$('[data-adj]', sheet).forEach((b) => b.addEventListener('click', () => {
      const i = $('#actualMin', sheet);
      i.value = Math.max(1, Number(i.value) + Number(b.dataset.adj));
    }));
  });
}

function saveDone(key, skip) {
  const [taskId, origin] = key.split('@');
  const task = taskById(taskId);
  const occ = ensureOcc(key);
  const est = occ.durationOverride || task.durationMin;
  const actual = skip ? null : Math.max(1, Number($('#actualMin')?.value) || est);
  const p = plan();
  const b = p.blocks.find((x) => x.key === key && x.type === 'task');
  occ.status = 'completada';
  occ.completedAt = new Date().toISOString();
  if (occ.startMin == null && b) occ.plannedStart = b.start;
  if (occ.startMin == null) occ.startMin = actual ? Math.max(0, Math.floor(nowMin() - actual)) : (b ? b.start : null);
  occ.actualMin = actual;
  let learnMsg = '';
  if (actual) {
    recordActual(state, taskId, origin, est, actual);
    const res = applyLearning(task, state.durationLog[taskId]);
    if (res.changed) {
      task.durationMin = res.to;
      learnMsg = ` Ajusté su duración a ${res.to} min según tus registros.`;
    } else if (res.suggestion) {
      learnMsg = ` Te viene llevando unos ${Math.round(res.suggestion.median)} min (la fijaste en ${task.durationMin}).`;
    }
  }
  const project = task.projectId ? projectById(task.projectId) : null;
  if (project) {
    const ns = $('#nextStep');
    project.sessions.push({ date: today(), minutes: actual || est, note: task.name, nextStep: ns ? ns.value.trim() : project.nextStep });
    if (ns) project.nextStep = ns.value.trim();
  }
  closeSheet();
  keepScreenOn(false);
  commit(`Completada: ${task.name}.${learnMsg}`);
  const after = plan();
  const nn = nowAndNext(after, nowMin());
  let msg = `Terminaste ${taskPhrase(task.name)}.`;
  if (actual) msg += ` Te llevó ${durationWords(actual)} y habíamos estimado ${durationWords(est)}.`;
  if (nn.nextTask) {
    const gap = Math.round(nn.nextTask.start - nowMin());
    msg += gap >= 10 ? ` Ahora tenés un descanso de ${durationWords(gap)} hasta ${taskPhrase(nn.nextTask.label)}.` : ` Sigue ${taskPhrase(nn.nextTask.label)}.`;
  } else msg += ' No queda nada más programado por hoy.';
  say(msg);
  if (occ.returnTo) {
    const back = state.occ[occ.returnTo];
    if (back && back.status === 'pendiente') setTimeout(() => openResumeSheet(occ.returnTo), 300);
  }
}

function moreTime(key, min) {
  const occ = ensureOcc(key);
  occ.extraMin = (occ.extraMin || 0) + min;
  commit(`+${min} min. La agenda se corrió.`);
  say(`Te doy ${durationWords(min)} más.`);
}

function openCantSheet(key) {
  const [taskId] = key.split('@');
  const task = taskById(taskId);
  const occ = ensureOcc(key);
  const recurring = task.recurrence.type !== 'once';
  const dur = occ.durationOverride || task.durationMin;
  openSheet(`<h2>No pasa nada</h2><p class="muted">${esc(task.name)} · ¿qué hacemos?</p>
    <div class="small muted" style="margin-top:12px">Si querés, contame por qué (ayuda a planificar mejor):</div>
    <div class="row wrap" style="margin-top:8px" id="reasons">${REASONS.map((r) => `<button class="chip ${occ.reason === r.id ? 'on' : ''}" data-reason="${r.id}">${esc(r.label)}</button>`).join('')}</div>
    <div class="btns">
      <button class="btn full" data-act="cantDo" data-key="${key}" data-do="later">Más tarde hoy (en 1 hora)</button>
      <button class="btn" data-act="cantDo" data-key="${key}" data-do="pick">Elegir hora</button>
      <button class="btn" data-act="cantDo" data-key="${key}" data-do="${recurring ? 'skip' : 'tomorrow'}">${recurring ? 'Saltear hoy' : 'Pasar a mañana'}</button>
      ${dur >= 20 ? `<button class="btn full" data-act="cantDo" data-key="${key}" data-do="reduce">Hacer solo una parte (${roundUp(dur / 2, 5)} min)</button>` : ''}
      ${!recurring ? `<button class="btn" data-act="cantDo" data-key="${key}" data-do="date">Otro día…</button>` : ''}
      <button class="btn danger" data-act="cantDo" data-key="${key}" data-do="cancel">Cancelar esta vez</button>
    </div>
    <div id="cantExtra"></div>`, (sheet) => {
    $$('[data-reason]', sheet).forEach((b) => b.addEventListener('click', () => {
      $$('[data-reason]', sheet).forEach((x) => x.classList.toggle('on', x === b && !x.classList.contains('on')));
      occ.reason = $('[data-reason].on', sheet)?.dataset.reason || null;
      save();
    }));
  });
}

function cantDo(key, what) {
  const [taskId, origin] = key.split('@');
  const task = taskById(taskId);
  const occ = ensureOcc(key);
  const n = nowMin();
  if (occ.status === 'en_curso') {
    occ.status = 'pendiente';
    delete occ.startMin;
    keepScreenOn(false);
  }
  const extra = $('#cantExtra');
  if (what === 'pick') {
    extra.innerHTML = `<label class="field"><span>¿A qué hora?</span><input type="time" id="pickTime" value="${fmtHM(roundUp(n + 60, 15))}"></label><button class="btn primary" style="width:100%;margin-top:10px" data-act="cantDo" data-key="${key}" data-do="pickSave">Mover</button>`;
    return;
  }
  if (what === 'date') {
    extra.innerHTML = `<label class="field"><span>¿Qué día?</span><input type="date" id="pickDate" value="${addDays(today(), 1)}"></label><button class="btn primary" style="width:100%;margin-top:10px" data-act="cantDo" data-key="${key}" data-do="dateSave">Mover</button>`;
    return;
  }
  let msg = '';
  if (what === 'later') {
    occ.notBefore = roundUp(n + 60, 5);
    occ.pinnedStart = null;
    msg = 'La reprogramo para dentro de una hora o cuando haya lugar.';
  } else if (what === 'pickSave') {
    const t = parseHM($('#pickTime').value);
    occ.pinnedStart = t;
    const p = plan();
    const c = p.conflicts.find((x) => x.key === key);
    if (c) {
      occ.pinnedStart = null;
      $('#cantExtra').innerHTML += `<div class="banner" style="margin-top:10px">⛔ ${esc(c.reason)}</div>`;
      return;
    }
    msg = `Movida a las ${fmtHM(t)}.`;
  } else if (what === 'tomorrow' || what === 'dateSave') {
    const to = what === 'tomorrow' ? addDays(today(), 1) : $('#pickDate').value;
    occ.status = 'pospuesta';
    occ.postponedTo = to;
    occ.pinnedStart = null;
    msg = `Pasada a ${humanDate(to)}.`;
  } else if (what === 'skip' || what === 'cancel') {
    occ.status = 'cancelada';
    msg = what === 'skip' ? 'Salteada por hoy.' : 'Cancelada esta vez.';
  } else if (what === 'reduce') {
    occ.durationOverride = roundUp((occ.durationOverride || task.durationMin) / 2, 5);
    msg = `Hoy hacés una parte: ${occ.durationOverride} min.`;
  }
  void origin;
  closeSheet();
  closeAlarm();
  commit(msg);
  say(msg);
}

function openTiredSheet() {
  const p = plan();
  const nn = nowAndNext(p, nowMin());
  const t = nn.current && nn.current.type === 'task' ? nn.current : nn.nextTask;
  if (t) {
    ensureOcc(t.key).reason = 'cansado';
    save();
  }
  const low = p.blocks.filter((b) => b.type === 'task' && b.status === 'pendiente' && !b.fixed && (b.priority || 2) === 3 && b.end > nowMin());
  openSheet(`<h2>Está bien estar cansado</h2><p class="muted">Elegí lo que te sirva:</p>
    <div class="btns">
      <button class="btn primary full" data-act="restNow" data-min="15">☕ Descanso de 15 min</button>
      <button class="btn full" data-act="restNow" data-min="30">Descanso de 30 min</button>
      ${low.length ? `<button class="btn full" data-act="lightenDay">Pasar a mañana lo de prioridad baja (${low.length})</button>` : ''}
      ${t ? `<button class="btn full" data-act="cant" data-key="${t.key}">Ver opciones para «${esc(t.label)}»</button>` : ''}
    </div>`);
  say('Está bien. Podés tomarte un descanso o aliviar el resto del día.');
}

function restNow(min) {
  const start = roundUp(nowMin(), 5);
  const t = newTask({ name: 'Descanso', category: 'descanso', durationMin: min, fixedTime: fmtHM(start), date: today(), priority: 1, adhoc: true });
  state.tasks.push(t);
  const occ = ensureOcc(occKey(t.id, today()));
  occ.status = 'en_curso';
  occ.startMin = start;
  closeSheet();
  commit(`Descanso hasta las ${fmtHM(start + min)}. Lo demás se corre.`);
  say(`Descansá ${durationWords(min)}. Te aviso cuando sigamos.`);
}

function lightenDay() {
  const p = plan();
  const tomorrow = addDays(today(), 1);
  let n = 0;
  for (const b of p.blocks) {
    if (b.type === 'task' && b.status === 'pendiente' && !b.fixed && (b.priority || 2) === 3 && b.end > nowMin()) {
      const task = taskById(b.taskId);
      const occ = ensureOcc(b.key);
      if (task.recurrence.type === 'once') {
        occ.status = 'pospuesta';
        occ.postponedTo = tomorrow;
      } else occ.status = 'cancelada';
      occ.reason = 'cansado';
      n++;
    }
  }
  closeSheet();
  commit(`${n} tareas livianas pasadas a mañana.`);
}

function openReplan() {
  const before = plan(today(), null);
  const after = plan(today(), nowMin());
  const d = diffPlans(before, after);
  const late = nowAndNext(before, nowMin()).late.filter((b) => b.fixed);
  ui.missed = [];
  if (!d.moved.length && !after.unscheduled.length && !late.length) {
    toast('Tu día sigue en orden. No hace falta mover nada.');
    say('Tu día sigue en orden.');
    render();
    return;
  }
  openSheet(`<h2>Reorganizar el día</h2>
    <p class="small muted">Lo fijo (trabajo, viajes, horarios fijos) no se toca. Esto es lo que propongo:</p>
    ${d.moved.length ? `<div class="section-title">Se mueven</div><div class="card"><ul class="list">${d.moved.map((m) => `<li class="small"><span class="grow">${esc(m.label)}</span><span>${fmtHM(m.from)} → <b>${fmtHM(m.to)}</b></span></li>`).join('')}</ul></div>` : ''}
    ${late.length ? `<div class="section-title">Con hora fija ya pasada</div><div class="card"><ul class="list">${late.map((b) => `<li class="small"><span class="grow">${esc(b.label)} (${fmtHM(b.start)})</span><button class="btn sm" data-act="cant" data-key="${b.key}">Opciones</button></li>`).join('')}</ul></div>` : ''}
    ${after.unscheduled.length ? `<div class="section-title">No entran hoy — elegí qué hacer</div><div class="card"><ul class="list">${after.unscheduled.map((u) => `<li style="display:block"><b class="small">${esc(u.inst.task.name)}</b><div class="tiny muted">${esc(u.reason)}</div><div class="row wrap" style="margin-top:6px">${u.suggestions.map((s, i) => `<button class="btn sm" data-act="suggest" data-key="${u.inst.key}" data-date="${today()}" data-i="${i}" data-now="1">${esc(s.label)}</button>`).join('')}</div></li>`).join('')}</ul></div>` : ''}
    <div class="btns"><button class="btn primary" data-act="applyReplan">Aplicar</button><button class="btn" data-act="closeSheet">Dejar como está</button></div>`);
  const parts = [];
  if (d.moved.length) parts.push(`Muevo ${d.moved.length === 1 ? 'una tarea' : `${d.moved.length} tareas`} para que no se superpongan`);
  if (after.unscheduled.length) parts.push(`${after.unscheduled.length === 1 ? 'una no entra' : `${after.unscheduled.length} no entran`} hoy, decidí qué hacemos`);
  if (parts.length) say(parts.join(', y ') + '.');
}

function applyReplan() {
  const after = plan(today(), nowMin());
  for (const b of after.blocks) {
    if (b.type === 'task' && !b.done && b.status === 'pendiente' && !b.fixed) ensureOcc(b.key).pinnedStart = b.start;
  }
  closeSheet();
  commit('Agenda reorganizada.');
}

function applySuggestion(key, date, i, withNow) {
  const p = withNow ? plan(date, nowMin()) : plan(date);
  const u = p.unscheduled.find((x) => x.inst.key === key);
  if (!u) return;
  const s = u.suggestions[i];
  const occ = ensureOcc(key);
  if (s.type === 'reduce') occ.durationOverride = s.minutes;
  if (s.type === 'move') {
    if (u.inst.task.recurrence.type === 'once' || key.split('@')[1] !== date) {
      occ.status = 'pospuesta';
      occ.postponedTo = s.to;
    } else {
      occ.status = 'cancelada';
      occ.reason = occ.reason || 'imprevisto';
    }
  }
  if (s.type === 'swap') {
    const v = ensureOcc(s.key);
    const vt = taskById(s.key.split('@')[0]);
    if (vt.recurrence.type === 'once') {
      v.status = 'pospuesta';
      v.postponedTo = addDays(date, 1);
    } else v.status = 'cancelada';
  }
  if (sheetOpen() && $('[data-act="applyReplan"]')) {
    closeSheet();
    commit(s.label);
    openReplan();
  } else commit(s.label);
}

function openDecide() {
  const list = pendingDecisions(state, today());
  openSheet(`<h2>Tareas para decidir</h2><p class="small muted">Quedaron de días anteriores. No se acumulan solas en tu agenda: elegí qué hacer con cada una.</p>
    <ul class="list">${list.map((x) => `<li style="display:block"><b>${esc(x.task.name)}</b><div class="tiny muted">Era para ${esc(humanDate(x.date))} · ${durationShort(x.task.durationMin)}</div>
    <div class="row wrap" style="margin-top:8px">
      <button class="btn sm" data-act="decideDo" data-key="${x.key}" data-do="today">Hoy</button>
      <button class="btn sm" data-act="decideDo" data-key="${x.key}" data-do="tomorrow">Mañana</button>
      <button class="btn sm" data-act="decideDo" data-key="${x.key}" data-do="done">Ya la hice</button>
      <button class="btn sm danger" data-act="decideDo" data-key="${x.key}" data-do="cancel">Cancelar</button></div></li>`).join('')}</ul>`);
}

function decideDo(key, what) {
  const occ = ensureOcc(key);
  if (what === 'today' || what === 'tomorrow') {
    occ.status = 'pospuesta';
    occ.postponedTo = what === 'today' ? today() : addDays(today(), 1);
  } else if (what === 'done') {
    occ.status = 'completada';
    occ.completedAt = new Date().toISOString();
  } else occ.status = 'cancelada';
  save();
  if (pendingDecisions(state, today()).length) openDecide();
  else closeSheet();
  render();
}

function blockMenu(key) {
  const [taskId, origin] = key.split('@');
  const task = taskById(taskId);
  const occ = state.occ[key] || {};
  const done = occ.status === 'completada';
  openSheet(`<h2>${esc(task.name)}</h2><p class="small muted">${durationShort(occ.durationOverride || task.durationMin)} · ${esc(recText(task))}${origin !== ui.agendaDate ? ` · viene del ${esc(humanDate(origin))}` : ''}</p>
    ${task.notes ? `<p class="small">${esc(task.notes)}</p>` : ''}
    <div class="btns">
      ${done ? `<button class="btn full" data-act="undoDone" data-key="${key}">Marcar como no hecha</button>` : `
      <button class="btn primary" data-act="start" data-key="${key}">▶ Empezar</button>
      <button class="btn ok" data-act="done" data-key="${key}">✓ Hecha</button>
      <button class="btn" data-act="cant" data-key="${key}">Mover / posponer</button>
      <button class="btn" data-act="announce" data-key="${key}">🔈 Escuchar</button>`}
      <button class="btn ghost full" data-act="editTask" data-id="${task.id}">Editar la tarea</button>
    </div>`);
}

// ---------- Compras y mandados ----------

function addShopItems(list) {
  const added = [];
  for (const raw of list) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const n = normalize(text);
    if (state.shopping.some((i) => !i.done && normalize(i.text) === n)) continue;
    state.shopping.push({ id: newId(), text, done: false, addedAt: new Date().toISOString() });
    added.push(text);
  }
  return added;
}

function shopItem(i) {
  return `<li><label class="row grow"><input type="checkbox" data-act="shopToggle" data-id="${i.id}" ${i.done ? 'checked' : ''}> <span class="${i.done ? 'muted' : ''}" ${i.done ? 'style="text-decoration:line-through"' : ''}>${esc(i.text)}</span></label><button class="btn sm ghost" data-act="shopDel" data-id="${i.id}" aria-label="Quitar">✕</button></li>`;
}

/** Lista para tildar mientras se hace una tarea de compras. */
function shopChecklist(block) {
  const occ = state.occ[block.key] || {};
  const items = occ.itemIds && occ.itemIds.length
    ? state.shopping.filter((i) => occ.itemIds.includes(i.id))
    : state.shopping.filter((i) => !i.done || (occ.startedAt && i.doneAt && i.doneAt >= occ.startedAt));
  if (!items.length) return '<div class="step">🛒 No hay nada en la lista de compras. Podés agregar cosas en la pestaña Compras.</div>';
  const left = items.filter((i) => !i.done).length;
  return `<div class="section-title">Para comprar · ${left ? `faltan ${left}` : 'todo listo ✓'}</div><ul class="list">${items.map(shopItem).join('')}</ul>`;
}

function viewCompras() {
  const pend = state.shopping.filter((i) => !i.done);
  const done = state.shopping.filter((i) => i.done);
  const trips = state.tasks.filter((t) => !t.archived && !t.adhoc && t.category === 'compras');
  return `<div class="card">
    <button class="btn primary big" data-act="errand">🏃 Tengo que salir ahora</button>
    <p class="small muted" style="margin:10px 0 0">Si estás en medio de una tarea, queda en pausa y la retomás cuando vuelvas.</p></div>
  <div class="section-title">Lista de compras · ${pend.length}</div>
  <div class="card">
    <div class="quickadd"><input type="text" id="shopAdd" placeholder="Ej: leche, pan y piedritas" autocomplete="off" enterkeyhint="done">
    <button class="mic" data-act="listenShop" aria-label="Dictar">🎙️</button></div>
    <button class="btn" style="width:100%;margin-top:10px" data-act="shopAdd">+ Agregar a la lista</button>
    ${pend.length ? `<ul class="list" style="margin-top:8px">${pend.map(shopItem).join('')}</ul>` : '<div class="empty small">La lista está vacía.</div>'}
    ${done.length ? `<div class="section-title">Comprado</div><ul class="list">${done.slice(-15).reverse().map(shopItem).join('')}</ul>
    <button class="btn sm ghost" style="margin-top:8px" data-act="shopClear">Borrar lo comprado</button>` : ''}
  </div>
  <div class="section-title">Salidas planificadas</div>
  <div class="card">${trips.length ? `<ul class="list">${trips.map((t) => `<li data-act="editTask" data-id="${t.id}" style="cursor:pointer"><div class="grow"><div class="name">${esc(t.name)}</div>
    <div class="small muted">${durationShort(t.durationMin)}${t.travelMin ? ` + ${t.travelMin} min de viaje por tramo` : ''} · ${esc(recText(t))}</div></div><span class="muted">›</span></li>`).join('')}</ul>` : '<div class="small muted">No hay salidas planificadas.</div>'}
    <button class="btn" style="width:100%;margin-top:10px" data-act="planErrand">+ Planificar una salida</button></div>
  <p class="tiny muted" style="margin:14px 4px">Cuando empezás una salida de la categoría Compras, la app te muestra esta lista para ir tildando lo que comprás. También podés decir: «Agregá yerba y azúcar a la lista», «Tengo que ir a comprar pan» o «Volví».</p>`;
}

function openErrandSheet(what = '') {
  const runningKey = Object.keys(state.occ).find((k) => state.occ[k].status === 'en_curso');
  const rTask = runningKey ? taskById(runningKey.split('@')[0]) : null;
  const pend = state.shopping.filter((i) => !i.done);
  openSheet(`<h2>🏃 Salir a un mandado</h2>
    ${rTask ? `<p class="small muted">«${esc(rTask.name)}» queda en pausa. Cuando vuelvas, seguís donde la dejaste.</p>` : ''}
    <label class="field"><span>¿A qué salís?</span><input type="text" id="erWhat" value="${esc(what)}" placeholder="Ej: comprar piedritas y pan, ir al banco" autocomplete="off"></label>
    ${pend.length ? `<div class="section-title">Sumar de tu lista de compras</div><ul class="list">${pend.map((i) => `<li><label class="row grow"><input type="checkbox" class="erItem" value="${i.id}"> <span>${esc(i.text)}</span></label></li>`).join('')}</ul>` : ''}
    <div class="section-title">¿Cuánto calculás que tardás?</div>
    <div class="row wrap" id="erMins">${[15, 30, 45, 60, 90].map((m) => `<button class="chip ${m === 30 ? 'on' : ''}" data-m="${m}">${m} min</button>`).join('')}</div>
    <div class="btns"><button class="btn primary big full" data-act="errandGo">🏃 Salir ahora</button>
    <button class="btn ghost full" data-act="closeSheet">Cancelar</button></div>`, (sheet) => {
    $$('#erMins [data-m]', sheet).forEach((b) => b.addEventListener('click', () => {
      $$('#erMins [data-m]', sheet).forEach((x) => x.classList.toggle('on', x === b));
    }));
  });
}

function startErrand(what, itemIds, minutes) {
  const n = nowMin();
  let paused = null;
  for (const [k, o] of Object.entries(state.occ)) {
    if (o.status !== 'en_curso') continue;
    const t = taskById(k.split('@')[0]);
    if (t && t.adhoc && t.category === 'descanso') {
      o.status = 'completada';
      o.actualMin = Math.max(1, Math.round(n - o.startMin));
      continue;
    }
    o.elapsedBefore = (o.elapsedBefore || 0) + Math.max(0, Math.round(n - (o.startMin ?? n)));
    o.status = 'pendiente';
    delete o.startMin;
    o.paused = true;
    o.resumeFirst = true;
    o.pinnedStart = null;
    if (t) paused = { key: k, task: t };
  }
  const items = [...itemIds];
  const m = /^comprar\s+(.+)$/i.exec(what);
  if (m) {
    const list = splitItems(m[1]);
    addShopItems(list);
    for (const it of list) {
      const f = state.shopping.find((i) => !i.done && normalize(i.text) === normalize(it));
      if (f && !items.includes(f.id)) items.push(f.id);
    }
  }
  let name = what ? what.charAt(0).toUpperCase() + what.slice(1) : (items.length ? 'Ir a comprar' : 'Mandado');
  if (/^(al|a la|a los|a las)\s/i.test(what)) name = `Ir ${what}`;
  const task = newTask({ name, category: 'compras', durationMin: minutes, date: today(), startDate: today(), adhoc: true, priority: 1 });
  state.tasks.push(task);
  state.occ[occKey(task.id, today())] = {
    status: 'en_curso', startMin: Math.floor(n), startedAt: new Date().toISOString(), plannedStart: Math.floor(n),
    extraMin: 0, itemIds: items, returnTo: paused ? paused.key : null,
  };
  closeSheet();
  closeAlarm();
  keepScreenOn(false);
  ui.tab = 'ahora';
  commit(paused ? `«${paused.task.name}» quedó en pausa. Cuando vuelvas, tocá «🏠 Volví».` : 'Mandado en curso. Cuando vuelvas, tocá «🏠 Volví».');
  say(`Dale, andá tranquilo.${paused ? ` Dejo en pausa ${taskPhrase(paused.task.name)}.` : ''}${items.length ? ` Tenés ${items.length === 1 ? 'una cosa' : `${items.length} cosas`} para comprar.` : ''} Cuando vuelvas, avisame.`);
}

function openResumeSheet(key) {
  const occ = state.occ[key];
  const task = taskById(key.split('@')[0]);
  if (!occ || !task || occ.status !== 'pendiente') return;
  const left = Math.max(5, (occ.durationOverride || task.durationMin) - (occ.elapsedBefore || 0));
  openSheet(`<h2>¡Volviste! 🏠</h2>
    <p class="muted">¿Seguimos con «${esc(task.name)}»? Te quedan unos ${left} min${occ.elapsedBefore ? ` (ya llevabas ${occ.elapsedBefore})` : ''}.</p>
    <div class="btns"><button class="btn primary big full" data-act="start" data-key="${key}">▶ Seguir ahora</button>
    <button class="btn full" data-act="closeSheet">Más tarde</button></div>`);
  say(`Volviste. ¿Seguimos con ${taskPhrase(task.name)}? Te quedan unos ${durationWords(left)}.`);
}

// ---------- Cambiar de tarea ----------

/** Devuelve la clave de la tarea para hoy, creándola si hoy no le tocaba. */
function todayKeyFor(task) {
  const d = today();
  if (occursOn(task, d, getDayType(d, state.settings))) return occKey(task.id, d);
  const moved = Object.entries(state.occ).find(([k, o]) => k.startsWith(task.id + '@') && o.postponedTo === d);
  if (moved) return moved[0];
  if (task.recurrence.type === 'once') {
    const key = occKey(task.id, task.date);
    ensureOcc(key).postponedTo = d;
    return key;
  }
  const key = occKey(task.id, d);
  ensureOcc(key).extra = true;
  return key;
}

function switchTo(taskId, fromKey) {
  const task = taskById(taskId);
  if (!task) return;
  const key = todayKeyFor(task);
  closeSheet();
  if (state.occ[key] && state.occ[key].status === 'en_curso') {
    toast(`Ya estás con ${task.name}.`);
    return;
  }
  const fromTask = fromKey && fromKey !== key ? taskById(fromKey.split('@')[0]) : null;
  if (fromTask) {
    const fo = ensureOcc(fromKey);
    if (!fromTask.fixedTime) fo.pinnedStart = null; // que se reacomode después
    fo.switchedAway = (fo.switchedAway || 0) + 1;
  }
  startTask(key);
  if (fromTask) toast(`Dale. «${fromTask.name}» queda para después: ya la reacomodé en tu agenda.`);
}

function switchNew(text, fromKey) {
  if (!text || !text.trim()) return;
  const t = taskFromText(text);
  t.fixedTime = null;
  t.date = today();
  t.startDate = today();
  state.tasks.push(t);
  switchTo(t.id, fromKey);
}

function openSwitchSheet(fromKey = null, query = '') {
  const p = plan();
  const fromTaskId = fromKey ? fromKey.split('@')[0] : null;
  const from = fromTaskId ? taskById(fromTaskId) : null;
  const todays = p.blocks.filter((b) => b.type === 'task' && !b.done && b.status !== 'en_curso' && b.taskId !== fromTaskId);
  const seen = new Set(todays.map((b) => b.taskId));
  const unsched = p.unscheduled.filter((u) => u.inst.task.id !== fromTaskId && !seen.has(u.inst.task.id));
  unsched.forEach((u) => seen.add(u.inst.task.id));
  const running = p.blocks.find((b) => b.type === 'task' && b.status === 'en_curso');
  if (running) seen.add(running.taskId);
  const others = state.tasks.filter((t) => !t.archived && !t.adhoc && t.id !== fromTaskId && !seen.has(t.id));
  const item = (id, name, meta) => `<li data-act="switchPick" data-id="${id}" data-from="${fromKey || ''}" data-n="${esc(normalize(name))}" style="cursor:pointer">
    <div class="grow"><div class="name">${esc(name)}</div><div class="small muted">${esc(meta)}</div></div><span class="btn sm primary">▶</span></li>`;
  openSheet(`<h2>¿Qué vas a hacer?</h2>
    ${from ? `<p class="small muted">«${esc(from.name)}» queda para después: la reacomodo sola en tu agenda.</p>` : ''}
    <input type="text" id="swq" placeholder="Buscar, o escribir una tarea nueva" value="${esc(query)}" autocomplete="off">
    <div class="section-title">De hoy</div>
    <ul class="list">${todays.map((b) => item(b.taskId, b.label, `${fmtHM(b.taskStart)} · ${durationShort(b.durationMin)}`)).join('') || '<li class="small muted">No hay otras tareas para hoy.</li>'}
    ${unsched.map((u) => item(u.inst.task.id, u.inst.task.name, `Sin lugar hoy · ${durationShort(u.inst.task.durationMin)}`)).join('')}</ul>
    ${others.length ? `<div class="section-title">Otras tareas</div><ul class="list">${others.map((t) => item(t.id, t.name, `${durationShort(t.durationMin)} · ${recText(t)}`)).join('')}</ul>` : ''}
    <div id="swNew"></div>
    <div class="btns"><button class="btn ghost full" data-act="closeSheet">Cancelar</button></div>`, (sheet) => {
    const q = $('#swq', sheet);
    const apply = () => {
      const v = normalize(q.value);
      $$('[data-n]', sheet).forEach((li) => li.classList.toggle('hidden', !!v && !li.dataset.n.includes(v)));
      $('#swNew', sheet).innerHTML = v ? `<button class="btn primary" style="width:100%;margin-top:14px" data-act="switchNew" data-from="${fromKey || ''}">▶ Empezar «${esc(q.value.trim())}» como tarea nueva</button>` : '';
    };
    q.addEventListener('input', apply);
    apply();
  });
}

// ---------- Concentración ----------

function startFocus({ minutes, key = null, projectId = null }) {
  const task = key ? taskById(key.split('@')[0]) : null;
  if (!projectId && task && task.projectId) projectId = task.projectId;
  state.focusActive = { id: newId(), date: today(), startedAt: Date.now(), plannedMin: Number(minutes), pausedMs: 0, pausedAt: null, interruptions: 0, key, projectId };
  if (key && (!state.occ[key] || state.occ[key].status !== 'en_curso')) startTask(key);
  save();
  closeSheet();
  showFocus();
  keepScreenOn(true);
  const project = projectId ? projectById(projectId) : null;
  say(`Bloque de ${durationWords(minutes)}. Guardá el celular lejos${project && project.nextStep ? ` y empezá por: ${project.nextStep}` : ''}.`);
}

function focusRemainingSec(f) {
  const paused = f.pausedMs + (f.pausedAt ? Date.now() - f.pausedAt : 0);
  return f.plannedMin * 60 - (Date.now() - f.startedAt - paused) / 1000;
}

function showFocus() {
  const f = state.focusActive;
  if (!f) return;
  let el = $('#focus');
  if (!el) {
    el = document.createElement('div');
    el.id = 'focus';
    el.className = 'focus';
    document.body.appendChild(el);
  }
  const project = f.projectId ? projectById(f.projectId) : null;
  const task = f.key ? taskById(f.key.split('@')[0]) : null;
  const R = 110;
  const C = 2 * Math.PI * R;
  el.innerHTML = `<div class="small muted">Concentración${task ? ` · ${esc(task.name)}` : project ? ` · ${esc(project.name)}` : ''}</div>
    ${project && project.nextStep ? `<h2 style="margin-top:8px">${esc(project.nextStep)}</h2>` : ''}
    <div class="ring"><svg width="240" height="240"><circle cx="120" cy="120" r="${R}" fill="none" stroke="var(--surface-2)" stroke-width="12"/>
      <circle id="ringArc" cx="120" cy="120" r="${R}" fill="none" stroke="var(--accent)" stroke-width="12" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg>
      <div class="val" id="focusVal">--:--</div></div>
    <p class="small muted" id="focusInfo">📵 Dejá el celular fuera de alcance. Si salís de la app, se cuenta como interrupción.</p>
    <div class="btns" style="width:100%;max-width:400px">
      <button class="btn" data-act="focusPause">${f.pausedAt ? '▶ Reanudar' : '⏸ Pausa'}</button>
      <button class="btn" data-act="focusEnd">Terminar</button></div>`;
  updateFocus();
}

function updateFocus() {
  const f = state.focusActive;
  const el = $('#focus');
  if (!f || !el) return;
  const rem = focusRemainingSec(f);
  const R = 110;
  const C = 2 * Math.PI * R;
  const v = $('#focusVal');
  if (v) v.textContent = rem > 0 ? `${Math.floor(rem / 60)}:${String(Math.floor(rem % 60)).padStart(2, '0')}` : '0:00';
  const arc = $('#ringArc');
  if (arc) arc.setAttribute('stroke-dashoffset', String(C * (1 - Math.max(0, rem) / (f.plannedMin * 60))));
  if (rem <= 0 && !f.pausedAt) finishFocus(true);
}

function finishFocus(completed) {
  const f = state.focusActive;
  if (!f) return;
  const elapsedMin = Math.round(Math.min(f.plannedMin * 60, f.plannedMin * 60 - Math.max(0, focusRemainingSec(f))) / 60);
  state.focus.push({ id: f.id, date: f.date, minutes: elapsedMin, planned: f.plannedMin, completed, interruptions: f.interruptions, taskKey: f.key, projectId: f.projectId });
  if (f.projectId && !f.key) {
    const p = projectById(f.projectId);
    if (p) p.sessions.push({ date: f.date, minutes: elapsedMin, note: 'Bloque de concentración', fromFocus: true });
  }
  state.focusActive = null;
  save();
  $('#focus')?.remove();
  keepScreenOn(false);
  if (completed) {
    playSound(state.settings.alarm.sound, state.settings.alarm.volume, 1);
    const project = f.projectId ? projectById(f.projectId) : null;
    openSheet(`<h2>Bloque terminado 🎯</h2><p class="muted">${elapsedMin} min de concentración${f.interruptions ? ` · ${f.interruptions} interrupciones` : ' · sin interrupciones'}.</p>
      ${project ? `<label class="field"><span>Próximo paso de «${esc(project.name)}»</span><textarea id="focusNext">${esc(project.nextStep)}</textarea></label>` : ''}
      <div class="btns">
        <button class="btn primary" data-act="focusAfter" data-do="break" data-project="${f.projectId || ''}">Pausa de ${state.settings.focus.breakMin} min</button>
        <button class="btn" data-act="focusAfter" data-do="again" data-project="${f.projectId || ''}" data-key="${f.key || ''}">Otro bloque</button>
        ${f.key ? `<button class="btn ok full" data-act="focusAfter" data-do="done" data-key="${f.key}" data-project="${f.projectId || ''}">La tarea está terminada</button>` : ''}
        <button class="btn ghost full" data-act="focusAfter" data-do="close" data-project="${f.projectId || ''}">Cerrar</button></div>`);
    say(`Terminó el bloque de concentración. ${f.interruptions ? '' : 'Sin interrupciones, muy bien. '}Tomate una pausa de ${durationWords(state.settings.focus.breakMin)}.`);
  } else {
    render();
  }
}

// ---------- Alarmas (con la app abierta) ----------

function alarmTick() {
  const d = today();
  const p = plan(d);
  const alarms = computeAlarms(p, state.settings);
  const n = nowMin();
  const fired = (state.alarmLog[d] = state.alarmLog[d] || []);
  let changed = false;
  for (const a of alarms) {
    const occ = a.key ? state.occ[a.key] : null;
    const id = a.key ? `${a.id}|${(occ && occ.snoozes) || 0}` : `${a.id}|${a.at}`;
    if (fired.includes(id) || a.at > n) continue;
    fired.push(id);
    changed = true;
    if (a.at > n - 10) {
      if (a.kind === 'alarma') ensureOcc(a.key).alarmedAt = Math.floor(n);
      fireAlarm(a);
    }
    else if (a.kind === 'alarma' && a.at > n - 180) ui.missed.push(a);
  }
  for (const k of Object.keys(state.alarmLog)) if (k < addDays(d, -3)) { delete state.alarmLog[k]; changed = true; }
  if (changed) {
    save();
    if (ui.missed.length && ui.tab === 'ahora' && !sheetOpen()) render();
  }
  if (state.focusActive) updateFocus();
}

function notify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.ready.then((r) => r.showNotification(title, { body, icon: 'icon-192.png', tag: 'asistente', renotify: true }));
    }
  } catch { /* sin notificaciones */ }
}

async function fireAlarm(a) {
  const al = state.settings.alarm;
  notify(a.title, a.body);
  if (a.kind !== 'alarma') {
    toast(`${a.title} · ${a.body}`);
    if (al.vibrate) vibrate([200, 100, 200]);
    await playSound(al.sound, al.volume * 0.7, 1);
    say(a.speech);
    return;
  }
  showAlarm(a.block, a);
}

function showAlarm(block, a = null) {
  closeAlarm();
  const task = taskById(block.taskId);
  const project = task && task.projectId ? projectById(task.projectId) : null;
  const step = nextStepFor(block);
  const el = document.createElement('div');
  el.className = 'alarm';
  el.id = 'alarm';
  el.setAttribute('role', 'alertdialog');
  el.innerHTML = `<div><div class="k">⏰ Es hora</div><div class="title">${esc(block.label)}</div>
    <div class="info">${fmtHM(block.taskStart)} – ${fmtHM(block.taskStart + block.durationMin)}<br>Tiempo estimado: ${durationShort(block.durationMin)}</div>
    ${step ? `<div class="info" style="margin-top:12px">${esc(step)}</div>` : ''}<div class="info small" id="alarmRepeat" style="margin-top:12px;opacity:.8"></div></div>
    <div>
      <button class="btn primary big" data-act="start" data-key="${block.key}">▶ Empezar</button>
      <div class="snooze">${[5, 10, 15, 30].map((m) => `<button class="btn" data-act="snooze" data-key="${block.key}" data-min="${m}">+${m}</button>`).join('')}</div>
      <div class="btns"><button class="btn" data-act="cant" data-key="${block.key}">No puedo</button><button class="btn" data-act="announce" data-key="${block.key}">🔈 Escuchar</button>
      <button class="btn full" data-act="switch" data-key="${block.key}">↔ Hago otra cosa</button>
      <button class="btn full" data-act="closeAlarm">Cerrar sin decidir</button></div>
    </div>`;
  document.body.appendChild(el);
  const speech = announceStart(block, { project, task });
  const ring = async (n) => {
    if (!$('#alarm')) return;
    if (state.settings.alarm.vibrate) vibrate();
    await playSound(state.settings.alarm.sound, state.settings.alarm.volume, 2);
    if (!$('#alarm')) return;
    say(speech);
    const max = Number(state.settings.alarm.maxRepeats) || 0;
    if (n < max) {
      $('#alarmRepeat').textContent = `Vuelvo a avisar en ${state.settings.alarm.repeatEveryMin} min (${n + 1}/${max}).`;
      ui.alarm.timer = setTimeout(() => ring(n + 1), (Number(state.settings.alarm.repeatEveryMin) || 3) * 60000);
    } else {
      $('#alarmRepeat').textContent = 'Sin respuesta: la tarea queda pendiente en tu agenda.';
    }
  };
  ui.alarm = { key: block.key, timer: null };
  void a;
  ring(0);
}

function closeAlarm() {
  if (ui.alarm && ui.alarm.timer) clearTimeout(ui.alarm.timer);
  ui.alarm = null;
  stopSound();
  stopSpeaking();
  $('#alarm')?.remove();
}

function snooze(key, min) {
  const occ = ensureOcc(key);
  occ.pinnedStart = roundUp(nowMin() + Number(min), 5);
  occ.snoozes = (occ.snoozes || 0) + 1;
  closeAlarm();
  const p = plan();
  const c = p.conflicts.find((x) => x.key === key);
  if (c) {
    occ.pinnedStart = null;
    commit();
    toast(`No se puede posponer tanto: ${c.reason}.`);
    openCantSheet(key);
    return;
  }
  commit(`Pospuesta a las ${fmtHM(occ.pinnedStart)}`);
}

// ---------- Comandos (texto o voz) ----------

function targetBlock() {
  if (ui.alarm) return plan().blocks.find((b) => b.key === ui.alarm.key && b.type === 'task');
  const nn = nowAndNext(plan(), nowMin());
  return nn.current && nn.current.type === 'task' ? nn.current : nn.nextTask;
}

function handleCommand(text) {
  const c = parseCommand(text);
  const b = targetBlock();
  const running = plan().blocks.find((x) => x.type === 'task' && x.status === 'en_curso');
  switch (c.intent) {
    case 'start':
      if (b) startTask(b.key);
      else say('No hay ninguna tarea para empezar ahora.');
      break;
    case 'done':
      if (running || b) openDoneSheet((running || b).key);
      break;
    case 'more':
      if (running) moreTime(running.key, c.minutes);
      else if (b) snooze(b.key, c.minutes);
      break;
    case 'cant':
      if (b) openCantSheet(b.key);
      break;
    case 'list': {
      const added = addShopItems(c.items);
      commit(added.length ? `Anoté en la lista: ${added.join(', ')}` : 'Eso ya estaba en la lista.');
      say(added.length ? `Listo, anoté ${added.join(', ')}.` : 'Eso ya estaba en la lista.');
      break;
    }
    case 'errand':
      openErrandSheet(c.what || '');
      break;
    case 'back': {
      if (running && running.category === 'compras') {
        openDoneSheet(running.key);
        break;
      }
      const pk = Object.keys(state.occ).find((k) => state.occ[k].paused && state.occ[k].status === 'pendiente');
      if (pk) openResumeSheet(pk);
      else {
        toast('¡Bienvenido de vuelta!');
        say('Bienvenido de vuelta.');
      }
      break;
    }
    case 'switch': {
      let from = running || b;
      if (c.instead) {
        // «En vez de X…»: la que queda para después es X, si está en la agenda de hoy
        const todays = plan().blocks.filter((x) => x.type === 'task' && !x.done);
        const insteadTask = findTask(c.instead, todays.map((x) => taskById(x.taskId)).filter(Boolean));
        if (insteadTask) from = todays.find((x) => x.taskId === insteadTask.id) || from;
      }
      if (!c.target) {
        openSwitchSheet(from ? from.key : null);
        break;
      }
      const todayIds = new Set(plan().blocks.filter((x) => x.type === 'task').map((x) => x.taskId));
      const hit = findTask(c.target, state.tasks.filter((t) => !t.archived && !t.adhoc), todayIds);
      if (hit) switchTo(hit.id, from && from.taskId !== hit.id ? from.key : null);
      else openSwitchSheet(from ? from.key : null, c.target);
      break;
    }
    case 'tired':
      openTiredSheet();
      break;
    case 'next': {
      const p = plan();
      const nn = nowAndNext(p, nowMin());
      const t = nn.nextTask;
      const msg = t
        ? `${t.start <= nowMin() ? 'Ahora toca' : `A las ${fmtHM(t.taskStart)} sigue`} ${taskPhrase(t.label)}, ${durationWords(t.durationMin)}.${nextStepFor(t) ? ' ' + nextStepFor(t) + '.' : ''}`
        : 'No queda nada programado por hoy.';
      toast(msg);
      say(msg);
      break;
    }
    case 'replan':
      openReplan();
      break;
    case 'postpone':
      if (b) snooze(b.key, c.minutes || 15);
      break;
    case 'today': {
      const msg = morningBrief(plan(), state);
      toast(msg);
      say(msg);
      break;
    }
    case 'pause':
      if (state.focusActive) ACTIONS.focusPause();
      break;
    case 'add':
      addFromText(text.replace(/^(agrega|agregá|agregar|anota|anotá|anotame|recordame|agenda|agendá|agendame|nueva tarea)\s*/i, ''), true);
      break;
    default:
      toast('No entendí. Probá: «¿Qué sigue?», «Terminé», «Necesito diez minutos más», «Reorganizá mi día».');
      say('No te entendí. Podés decir: qué sigue, terminé, o necesito diez minutos más.');
  }
}

async function listen(onText) {
  if (!recognitionAvailable()) {
    toast('Tu navegador no ofrece reconocimiento de voz acá. Tocá el cuadro de texto y usá el micrófono del teclado.');
    const input = $('#cmd') || $('#qa');
    input?.focus();
    return;
  }
  const btns = $$('.mic');
  btns.forEach((b) => b.classList.add('listening'));
  stopSpeaking();
  try {
    const text = await listenOnce({ onInterim: (t) => { const i = $('#cmd') || $('#qa'); if (i) i.value = t; } });
    if (text) onText(text);
    else toast('No escuché nada.');
  } catch (e) {
    toast(e.message);
  } finally {
    btns.forEach((b) => b.classList.remove('listening'));
  }
}

// ---------- Descargas ----------

async function shareOrDownload(name, content, mime) {
  const file = new File([content], name, { type: mime });
  if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

// ---------- Onboarding ----------

function openOnboarding() {
  const s = state.settings;
  const mon = mondayOf(today());
  openSheet(`<h2>Configuración inicial</h2>
    <p class="small muted">Tres cosas y listo. Todo se puede cambiar después en Más → Ajustes.</p>
    <div class="section-title">1. ¿Qué turno tenés esta semana?</div>
    <div class="row">${['manana', 'tarde'].map((x) => `<button class="chip ${getDayType(mon, { ...s, overrides: {}, workDays: [1] }) === x ? 'on' : ''}" data-act="weekShift" data-mon="${mon}" data-shift="${x}" data-stay="1">${DAY_TYPES[x]}</button>`).join('')}</div>
    <p class="tiny muted">Mañana ${s.shifts.manana.start}–${s.shifts.manana.end} · Tarde ${s.shifts.tarde.start}–${s.shifts.tarde.end} (y sábado ${s.shifts.sabado.start}–${s.shifts.sabado.end}) · viaje ${s.travelMin} min. Las semanas se alternan solas.</p>
    <div class="section-title">2. Tareas de la casa</div>
    <button class="btn" style="width:100%" data-act="homePresets" data-stay="1">🏠 Cargar tareas de hogar sugeridas</button>
    <div class="section-title">3. Sonido y voz</div>
    <button class="btn" style="width:100%" data-act="unlock">🔊 Activar y probar</button>
    <div class="btns"><button class="btn primary full" data-act="closeSheet">Listo</button></div>`);
}

// ---------- Mapa de acciones ----------

const ACTIONS = {
  tab: (d) => { ui.tab = d.tab; closeSheet(); render(); window.scrollTo(0, 0); },
  dismiss: (d) => { ui.dismissed.add(d.id); render(); },
  closeSheet,
  closeAlarm: () => { closeAlarm(); render(); },
  unlock: async () => {
    const ok = await unlockAudio();
    initVoice();
    if (ok) {
      await playSound(state.settings.alarm.sound, state.settings.alarm.volume * 0.6, 1);
      say('Sonido y voz activados.');
      toast('🔊 Sonido y voz activados');
    } else toast('No se pudo activar el sonido. Revisá el volumen y probá de nuevo.');
    renderTop();
    if (ui.tab === 'ahora' && !sheetOpen()) render();
  },
  start: (d) => { closeSheet(); startTask(d.key); },
  done: (d) => { if (isTest(d.key)) return; closeAlarm(); openDoneSheet(d.key); },
  saveDone: (d) => saveDone(d.key, !!d.skip),
  undoDone: (d) => { const o = ensureOcc(d.key); o.status = 'pendiente'; delete o.actualMin; delete o.completedAt; delete o.startMin; closeSheet(); commit('Marcada como no hecha'); },
  more: (d) => moreTime(d.key, Number(d.min)),
  cant: (d) => { if (isTest(d.key)) return; closeAlarm(); openCantSheet(d.key); },
  cantDo: (d) => cantDo(d.key, d.do),
  switch: (d) => {
    const k = d.key && d.key !== 'prueba@x' ? d.key : (targetBlock()?.key || null);
    closeAlarm();
    openSwitchSheet(k);
  },
  switchPick: (d) => switchTo(d.id, d.from || null),
  switchNew: (d) => switchNew($('#swq')?.value, d.from || null),
  shopAdd: () => {
    const added = addShopItems(splitItems($('#shopAdd')?.value || ''));
    commit(added.length ? `Anotado: ${added.join(', ')}` : 'Eso ya estaba en la lista.');
    setTimeout(() => $('#shopAdd')?.focus(), 50);
  },
  shopToggle: (d, el) => {
    const it = state.shopping.find((i) => i.id === d.id);
    if (!it) return;
    it.done = !!el.checked;
    it.doneAt = it.done ? new Date().toISOString() : null;
    commit();
  },
  shopDel: (d) => { state.shopping = state.shopping.filter((i) => i.id !== d.id); commit(); },
  shopClear: () => { state.shopping = state.shopping.filter((i) => !i.done); commit('Lista limpia'); },
  listenShop: () => listen((t) => {
    const added = addShopItems(splitItems(t));
    commit(added.length ? `Anotado: ${added.join(', ')}` : 'No entendí qué agregar.');
  }),
  errand: () => openErrandSheet(''),
  errandGo: () => {
    const what = ($('#erWhat')?.value || '').trim();
    const ids = $$('.erItem').filter((x) => x.checked).map((x) => x.value);
    const mins = Number($('#erMins .on')?.dataset.m || 30);
    startErrand(what, ids, mins);
  },
  planErrand: () => openTaskForm(newTask({ name: 'Ir a comprar', category: 'compras', durationMin: 30, travelMin: 10, date: today(), startDate: today() })),
  snooze: (d) => { if (!isTest(d.key)) snooze(d.key, d.min); },
  announce: (d) => {
    if (d.key === 'prueba@x') return speak('Es hora de limpiar la casa. Esto es una prueba.');
    const b = plan(ui.tab === 'agenda' ? ui.agendaDate : today()).blocks.find((x) => x.key === d.key && x.type === 'task');
    if (!b) return;
    const task = taskById(b.taskId);
    speak(announceStart(b, { task, project: task.projectId ? projectById(task.projectId) : null }), { rate: state.settings.alarm.voiceRate });
  },
  step: (d, el) => {
    const occ = ensureOcc(d.key);
    const i = Number(d.i);
    occ.stepsDone = occ.stepsDone || [];
    if (el.checked) occ.stepsDone.push(i);
    else occ.stepsDone = occ.stepsDone.filter((x) => x !== i);
    commit();
  },
  cmd: (d) => handleCommand(d.text),
  listen: () => listen(handleCommand),
  listenAdd: () => listen((t) => { $('#qa').value = t; previewQuick(t); }),
  brief: () => { const m = morningBrief(plan(), state); toast(m); speak(m, { rate: state.settings.alarm.voiceRate }); },
  briefDay: (d) => { const m = morningBrief(plan(d.date), state); speak(m, { rate: state.settings.alarm.voiceRate }); toast(m); },
  replan: openReplan,
  applyReplan,
  suggest: (d) => applySuggestion(d.key, d.date, Number(d.i), !!d.now),
  decide: openDecide,
  decideDo: (d) => decideDo(d.key, d.do),
  restNow: (d) => restNow(Number(d.min)),
  lightenDay,
  blockMenu: (d) => blockMenu(d.key),
  focus: (d) => startFocus({ minutes: Number(d.min) || state.settings.focus.defaultMin, key: d.key || null, projectId: d.project || null }),
  focusPause: () => {
    const f = state.focusActive;
    if (!f) return;
    if (f.pausedAt) { f.pausedMs += Date.now() - f.pausedAt; f.pausedAt = null; } else f.pausedAt = Date.now();
    save();
    showFocus();
  },
  focusEnd: () => finishFocus(focusRemainingSec(state.focusActive) <= 60),
  focusAfter: (d) => {
    const p = d.project ? projectById(d.project) : null;
    const ns = $('#focusNext');
    if (p && ns) p.nextStep = ns.value.trim();
    closeSheet();
    if (d.do === 'break') restNow(state.settings.focus.breakMin);
    else if (d.do === 'again') startFocus({ minutes: state.settings.focus.defaultMin, key: d.key || null, projectId: d.project || null });
    else if (d.do === 'done') openDoneSheet(d.key);
    else commit();
  },
  agendaNav: (d) => { ui.agendaDate = addDays(ui.agendaDate, Number(d.n)); render(); },
  agendaToday: () => { ui.agendaDate = today(); render(); },
  agendaMode: (d) => { ui.agendaMode = d.mode; render(); },
  gotoDay: (d) => { ui.agendaDate = d.date; ui.agendaMode = 'dia'; render(); window.scrollTo(0, 0); },
  dayType: (d) => {
    openSheet(`<h2>${esc(humanDate(d.date))}</h2><p class="small muted">Cambiar solo este día (ej. franco, cambio de turno, vacaciones):</p>
      <div class="btns">${Object.entries(DAY_TYPES).map(([k, v]) => `<button class="btn" data-act="setOverride" data-date="${d.date}" data-type="${k}">${v}</button>`).join('')}
      ${state.settings.overrides[d.date] ? `<button class="btn ghost full" data-act="delOverride" data-date="${d.date}">Volver a lo normal</button>` : ''}</div>`);
  },
  setOverride: (d) => { state.settings.overrides[d.date] = d.type; closeSheet(); commit(`${humanDate(d.date)}: ${DAY_TYPES[d.type]}`); },
  delOverride: (d) => { delete state.settings.overrides[d.date]; closeSheet(); commit(); },
  addOverride: () => {
    const from = $('#ovFrom').value;
    const to = $('#ovTo').value || from;
    const type = $('#ovType').value;
    if (!from || to < from) return toast('Revisá las fechas.');
    for (let d = from; d <= to; d = addDays(d, 1)) state.settings.overrides[d] = type;
    commit('Excepción agregada');
  },
  weekShift: (d) => {
    state.settings.weekShifts[d.mon] = d.shift;
    save();
    if (d.stay) { openOnboarding(); render(); } else commit(`Semana: ${DAY_TYPES[d.shift]}`);
  },
  workDay: (d) => {
    const n = Number(d.day);
    const w = state.settings.workDays;
    state.settings.workDays = w.includes(n) ? w.filter((x) => x !== n) : [...w, n];
    commit();
  },
  editTask: (d) => openTaskForm(d.id ? taskById(d.id) : null),
  quickAdd: () => { const v = $('#qa').value; if (v.trim()) addFromText(v); },
  archiveTask: (d) => { taskById(d.id).archived = true; closeSheet(); commit('Tarea archivada'); },
  deleteTask: (d) => {
    if (!confirm('¿Eliminar la tarea y su historial?')) return;
    state.tasks = state.tasks.filter((t) => t.id !== d.id);
    for (const k of Object.keys(state.occ)) if (k.startsWith(d.id + '@')) delete state.occ[k];
    delete state.durationLog[d.id];
    closeSheet();
    commit('Tarea eliminada');
  },
  homePresets: (d) => {
    const existing = new Set(state.tasks.map((t) => t.name));
    const add = homePresets(today()).filter((t) => !existing.has(t.name));
    state.tasks.push(...add);
    save();
    if (d.stay) toast(`Agregadas ${add.length} tareas de hogar. Ajustá las duraciones en Tareas.`);
    else commit(`Agregadas ${add.length} tareas de hogar. Tocá cada una para ajustar duración y días.`);
  },
  editProject: (d) => openProjectForm(d.id ? projectById(d.id) : null),
  deleteProject: (d) => {
    if (!confirm('¿Eliminar el proyecto?')) return;
    state.projects = state.projects.filter((p) => p.id !== d.id);
    state.tasks.forEach((t) => { if (t.projectId === d.id) t.projectId = null; });
    closeSheet();
    commit('Proyecto eliminado');
  },
  projectBlock: (d) => {
    const p = projectById(d.id);
    let t = state.tasks.find((x) => x.projectId === p.id && !x.archived);
    if (!t) {
      t = newTask({ name: `Proyecto: ${p.name}`, category: 'proyecto', projectId: p.id, durationMin: state.settings.focus.defaultMin, recurrence: { type: 'daily', days: [], interval: 1 }, startDate: today(), priority: 2 });
      state.tasks.push(t);
      save();
    }
    openTaskForm(t);
  },
  masTab: (d) => { ui.masTab = d.id; render(); },
  statsRange: (d) => { ui.statsRange = d.id; render(); },
  applyDuration: (d) => {
    const t = taskById(d.id);
    t.durationMin = Number(d.val);
    commit(`«${t.name}» ahora dura ${d.val} min`);
  },
  testSound: async () => { await unlockAudio(); playSound(state.settings.alarm.sound, state.settings.alarm.volume, 1); },
  testAlarm: async () => {
    await unlockAudio();
    const b = { key: 'prueba@x', taskId: null, label: 'Limpiar la casa (prueba)', taskStart: roundUp(nowMin(), 5), start: roundUp(nowMin(), 5), durationMin: 90, type: 'task' };
    toast('La alarma de prueba suena en 5 segundos. Podés bloquear la pantalla para ver qué pasa.');
    setTimeout(() => showAlarm(b), 5000);
  },
  askNotif: async () => {
    try {
      await Notification.requestPermission();
    } catch { /* */ }
    render();
  },
  ics: async (d) => {
    const plans = [];
    for (let i = 0; i < Number(d.days); i++) plans.push(plan(addDays(d.from, i)));
    const ics = buildICS(plans, { leadMin: state.settings.alarm.leadMin });
    await shareOrDownload(`agenda-${d.from}.ics`, ics, 'text/calendar');
    toast('Abrí el archivo y tocá «Agregar todo» para sumarlo al Calendario.');
  },
  exportJson: async () => {
    const ok = await shareOrDownload(`asistente-respaldo-${today()}.json`, exportJSON(state), 'application/json');
    if (ok) {
      state.settings.lastBackupAt = new Date().toISOString();
      commit('Copia exportada');
    }
  },
  snapshots: async () => {
    const snaps = await store.listSnapshots();
    openSheet(`<h2>Copias automáticas</h2><p class="small muted">Se guarda una cada 6 horas de uso (las últimas 7).</p>
      ${snaps.length ? `<ul class="list">${snaps.map((s) => `<li><span class="grow small">${new Date(s.at).toLocaleString('es-AR')} · ${s.state.tasks.length} tareas</span><button class="btn sm" data-act="restoreSnap" data-at="${s.at}">Restaurar</button></li>`).join('')}</ul>` : '<div class="empty small">Todavía no hay copias automáticas.</div>'}`);
  },
  restoreSnap: async (d) => {
    if (!confirm('¿Reemplazar los datos actuales por esta copia?')) return;
    const snaps = await store.listSnapshots();
    const s = snaps.find((x) => String(x.at) === d.at);
    if (!s) return;
    await store.snapshot(JSON.parse(JSON.stringify(state)));
    state = migrate(s.state);
    closeSheet();
    commit('Copia restaurada');
  },
  resetAll: async () => {
    if (!confirm('¿Borrar TODOS los datos? Exportá una copia antes si la querés.')) return;
    if (!confirm('Última confirmación: se borra todo.')) return;
    await store.snapshot(JSON.parse(JSON.stringify(state)));
    state = migrate(null);
    commit('Datos borrados (quedó una copia automática por las dudas)');
  },
  onboarding: openOnboarding,
};

// ---------- Eventos ----------

function bindEvents() {
  document.addEventListener('click', (e) => {
    if (e.target.matches('[data-overlay]')) return closeSheet();
    const tabBtn = e.target.closest('[data-tab].tab');
    if (tabBtn) return ACTIONS.tab({ tab: tabBtn.dataset.tab });
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.act];
    if (!fn) return;
    if (el.tagName === 'INPUT' && el.type === 'checkbox') return; // se maneja en change
    e.preventDefault();
    fn({ ...el.dataset }, el);
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches('input[type=checkbox][data-act]')) return ACTIONS[el.dataset.act]({ ...el.dataset }, el);
    if (el.matches('[data-set]')) {
      const path = el.dataset.set;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'number' || el.type === 'range') v = Number(v);
      if (path === 'focus.defaultMin') v = Number(v);
      setPath(state.settings, path, v);
      save();
      renderTop();
      toast('Guardado');
    }
    if (el.id === 'importFile' && el.files[0]) {
      el.files[0].text().then((txt) => {
        let obj;
        try {
          obj = JSON.parse(txt);
        } catch {
          return toast('El archivo no es un JSON válido.');
        }
        const err = validateImport(obj);
        if (err) return toast(err);
        if (!confirm(`¿Reemplazar tus datos por la copia (${obj.tasks.length} tareas)?`)) return;
        store.snapshot(JSON.parse(JSON.stringify(state)));
        delete obj.exportedAt;
        delete obj.app;
        state = migrate(obj);
        commit('Copia importada');
      });
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'qa') previewQuick(e.target.value);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'cmd' && e.target.value.trim()) {
      handleCommand(e.target.value);
      e.target.value = '';
    }
    if (e.target.id === 'qa' && e.target.value.trim()) {
      e.preventDefault();
      addFromText(e.target.value);
    }
    if (e.target.id === 'shopAdd' && e.target.value.trim()) {
      e.preventDefault();
      ACTIONS.shopAdd();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const f = state.focusActive;
      if (f && !f.pausedAt) {
        f.interruptions++;
        save(true);
      }
    } else {
      alarmTick();
      if (!sheetOpen()) render();
      if (state.focusActive) showFocus();
    }
  });
}

function tick() {
  const n = nowMin();
  const c = $('[data-clock]');
  if (c) c.textContent = fmtHM(n);
  $$('[data-countdown]').forEach((el) => { el.textContent = countdownText(Number(el.dataset.countdown), el.dataset.prefix); });
  $$('[data-remaining]').forEach((el) => { el.textContent = remainingText(Number(el.dataset.remaining)); });
  $$('[data-progress]').forEach((el) => {
    const [a, b] = el.dataset.progress.split(',').map(Number);
    el.style.width = `${Math.min(100, Math.max(0, ((n - a) / (b - a)) * 100))}%`;
  });
  if (state.focusActive) updateFocus();
  const minute = Math.floor(n);
  if (minute !== ui.lastMinute) {
    if (today() !== ui.lastDate) {
      ui.lastDate = today();
      ui.agendaDate = today();
    }
    const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (!typing && !sheetOpen() && ['ahora', 'agenda'].includes(ui.tab)) render();
    else ui.lastMinute = minute;
  }
}

// ---------- Inicio ----------

async function boot() {
  state = await store.init();
  ui.lastDate = today();
  initVoice();
  bindEvents();
  render();
  if (state.focusActive) showFocus();
  setInterval(tick, 1000);
  setInterval(alarmTick, 15000);
  alarmTick();
  if (!state.tasks.length && !state.projects.length && !localStorage.getItem('asistente-onboarded')) {
    localStorage.setItem('asistente-onboarded', '1');
    openOnboarding();
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker no registrado', e));
  }
  window.__app = { get state() { return state; }, plan, handleCommand, ACTIONS };
}

boot().catch((e) => {
  console.error(e);
  $('#view').innerHTML = `<div class="banner">No se pudo iniciar la app: ${esc(e.message)}. Probá recargar.</div>`;
});
