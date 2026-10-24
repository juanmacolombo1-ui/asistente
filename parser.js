// Intérprete de frases en español rioplatense, sin IA: reglas locales que funcionan sin conexión.
import { addDays, weekday, pad } from './time.js';

const NUMS = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veinticinco: 25, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, noventa: 90,
};
const NUM_RE = '(\\d+(?:[.,]\\d+)?|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veinticinco|treinta|cuarenta(?: y cinco)?|cincuenta|sesenta|noventa)';

function num(w) {
  if (w == null) return null;
  w = w.trim();
  if (/^\d/.test(w)) return Number(w.replace(',', '.'));
  if (w === 'cuarenta y cinco') return 45;
  return NUMS[w] ?? null;
}

export function normalize(text) {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[¿?¡!.,;]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const DAY_NAMES = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, sabados: 6, domingos: 0 };

const CATEGORY_WORDS = [
  ['gimnasio', /\b(gimnasio|gym|entrenar|correr|pesas)\b/],
  ['compras', /\b(super|supermercado|comprar|compras|mandado|mandados|verduleria|almacen|farmacia)\b/],
  ['salud', /\b(medico|medica|turno medico|dentista|odontologo|analisis|remedio|pastilla|kinesiologo)\b/],
  ['pareja', /\b(novia|novio|pareja|mi mujer|mi marido|cita|aniversario)\b/],
  ['proyecto', /\b(proyecto|bot|trading|curso|programar|n8n|faceless|codigo|estudiar)\b/],
  ['administracion', /\b(pagar|factura|banco|tramite|impuesto|afip|arca|vencimiento|papeles)\b/],
  ['descanso', /\b(descansar|siesta|dormir|relajar)\b/],
  ['trabajo', /\b(trabajo|reunion|informe|mail del laburo|laburo)\b/],
  ['hogar', /\b(limpiar|limpieza|lavar|barrer|trapo|planchar|ordenar|placar|placares|cocina|bano|gatos|piedritas|cajas|ropa|basura|platos)\b/],
];

const AREA_WORDS = [
  ['Cajas de los gatos', /\b(gatos|piedritas|arenero|caja de los gatos|cajas de los gatos)\b/],
  ['Ropa', /\b(ropa|lavarropas|planchar|tender)\b/],
  ['Placares', /\b(placar|placares)\b/],
  ['Cocina', /\b(cocina|platos|heladera)\b/],
  ['Baño', /\b(bano)\b/],
  ['Compras de alimentos', /\b(super|supermercado|verduleria|almacen)\b/],
  ['Productos de limpieza', /\b(productos de limpieza|lavandina|detergente)\b/],
  ['Limpieza general', /\b(toda la casa|limpieza completa|limpiar la casa|limpieza general|barrer)\b/],
  ['Orden general', /\b(ordenar)\b/],
];

/** Extrae una duración. Devuelve { minutes, match } o null. */
export function parseDuration(text) {
  const t = normalize(text);
  const rules = [
    [/\b(?:una )?hora y media\b/, () => 90],
    [/\b(?:una )?hora y cuarto\b/, () => 75],
    [/\bhora y tres cuartos\b/, () => 105],
    [/\bmedia hora\b/, () => 30],
    [/\b(?:un )?cuarto de hora\b/, () => 15],
    [new RegExp(`\\b${NUM_RE} horas? y media\\b`), (m) => num(m[1]) * 60 + 30],
    [new RegExp(`\\b${NUM_RE} horas? (?:y )?${NUM_RE} (?:minutos?|min)\\b`), (m) => num(m[1]) * 60 + num(m[2])],
    [new RegExp(`\\b${NUM_RE} horas? y ${NUM_RE}\\b`), (m) => num(m[1]) * 60 + num(m[2])],
    [/\b(\d{1,2})\s?h\s?(\d{1,2})\b/, (m) => Number(m[1]) * 60 + Number(m[2])],
    [new RegExp(`\\b${NUM_RE} ?(?:horas?|hs|h)\\b`), (m) => Math.round(num(m[1]) * 60)],
    [new RegExp(`\\b${NUM_RE} ?(?:minutos?|mins?|m)\\b`), (m) => num(m[1])],
  ];
  for (const [re, fn] of rules) {
    const m = re.exec(t);
    if (m) {
      const minutes = fn(m);
      if (minutes && minutes > 0 && minutes <= 24 * 60) return { minutes: Math.round(minutes), match: m[0] };
    }
  }
  return null;
}

/** Extrae una hora. "a las 4 de la tarde" -> "16:00"; "a las 16:30" -> "16:30". */
export function parseTime(text) {
  const t = normalize(text);
  const re = new RegExp(`\\ba (?:las|la) ${NUM_RE}(?:[:.](\\d{2})| y (media|cuarto))?(?: ?(?:hs|horas|h))?(?: de la (manana|tarde|noche)| del mediodia)?`);
  const m = re.exec(t);
  if (!m) return null;
  let h = num(m[1]);
  if (h == null || h > 24) return null;
  let min = m[2] ? Number(m[2]) : m[3] === 'media' ? 30 : m[3] === 'cuarto' ? 15 : 0;
  const part = m[4];
  if (part === 'tarde' && h < 12) h += 12;
  if (part === 'noche' && h < 12) h = h === 12 ? 0 : h + 12;
  if (/del mediodia/.test(m[0]) && h < 12) h = 12;
  if (h === 24) h = 0;
  if (min > 59) return null;
  return { time: `${pad(h)}:${pad(min)}`, match: m[0] };
}

/** Extrae fecha o recurrencia. */
export function parseWhen(text, today) {
  const t = normalize(text);
  const days = [];
  for (const [w, d] of Object.entries(DAY_NAMES)) if (new RegExp(`\\b${w}\\b`).test(t) && !days.includes(d)) days.push(d);
  if (/\b(todos los dias|cada dia|diariamente|diaria|a diario)\b/.test(t)) {
    return { recurrence: { type: 'daily', days: [], interval: 1 }, match: /\b(todos los dias|cada dia|diariamente|diaria|a diario)\b/.exec(t)[0] };
  }
  if (/\b(todos los meses|cada mes|mensual|una vez por mes)\b/.test(t)) {
    const dm = /\bel (\d{1,2}) de cada mes\b/.exec(t);
    return { recurrence: { type: 'monthly', days: [], interval: 1, dayOfMonth: dm ? Number(dm[1]) : null }, match: 'mensual' };
  }
  const every = /\bcada (\d+|dos|tres|cuatro|cinco|seis|siete|diez|quince) dias\b/.exec(t);
  if (every) return { recurrence: { type: 'custom', days: [], interval: num(every[1]) }, match: every[0] };
  if (days.length && /\b(todos los|cada|los)\b/.test(t)) {
    const interval = /\bcada dos semanas\b|\bsemana por medio\b/.test(t) ? 2 : 1;
    return { recurrence: { type: 'weekly', days: days.sort(), interval }, match: 'semanal' };
  }
  if (/\b(una vez por semana|semanal|semanalmente|cada semana)\b/.test(t)) {
    return { recurrence: { type: 'weekly', days: [weekday(today)], interval: 1 }, match: 'semanal' };
  }
  if (/\bpasado manana\b/.test(t)) return { date: addDays(today, 2), match: 'pasado manana' };
  // "mañana" como día, no "de la mañana" / "a la mañana" / "por la mañana"
  if (/(^|\s)manana\b/.test(t.replace(/\b(de|a|por|en) la manana\b/g, ''))) return { date: addDays(today, 1), match: 'manana' };
  if (/\bhoy\b/.test(t)) return { date: today, match: 'hoy' };
  if (days.length === 1) {
    let diff = (days[0] - weekday(today) + 7) % 7;
    if (diff === 0) diff = 7;
    return { date: addDays(today, diff), match: Object.keys(DAY_NAMES).find((k) => DAY_NAMES[k] === days[0]) };
  }
  const dmy = /\bel (\d{1,2})\/(\d{1,2})\b/.exec(t);
  if (dmy) {
    const y = Number(today.slice(0, 4));
    let date = `${y}-${pad(Number(dmy[2]))}-${pad(Number(dmy[1]))}`;
    if (date < today) date = `${y + 1}-${pad(Number(dmy[2]))}-${pad(Number(dmy[1]))}`;
    return { date, match: dmy[0] };
  }
  return null;
}

const STRIP = [
  /\b(me lleva|me llevan|me tarda|tardo|tarda|lleva|dura|durante|en total|aproximadamente|aprox|mas o menos)\b/g,
  /\b(recordame|recorda|anota|anotame|agenda|agendame|agregar|agrega|quiero|tengo que|hay que|necesito)\b/g,
  /\b(todos los dias|cada dia|diariamente|a diario|todos los meses|cada mes|una vez por semana|cada semana|semanal(?:mente)?|cada dos semanas|semana por medio)\b/g,
  /\b(todos los|cada) (lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)\b/g,
  /\b(los|el) (lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)\b/g,
  /\b(lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)\b/g,
  /\b(pasado manana|hoy)\b/g,
  /\b(a|por|en) la (manana|tarde|noche)\b/g,
  /\b(urgente|importante|prioridad alta|prioridad baja|sin apuro)\b/g,
];

function cleanName(original, normalizedRemovals) {
  let name = normalize(original);
  for (const r of normalizedRemovals) if (r) name = name.replace(r, ' ');
  for (const re of STRIP) name = name.replace(re, ' ');
  name = name.replace(/(^|\s)manana(\s|$)/g, ' ').replace(/\b(y|de|a|en|por)\s*$/g, '').replace(/\s+/g, ' ').trim();
  name = name.replace(/^(que|y|de)\s+/, '').trim();
  // Recuperar tildes/mayúsculas del texto original cuando es posible
  const origWords = original.split(/\s+/);
  const restored = name.split(' ').map((w) => {
    const hit = origWords.find((o) => normalize(o) === w);
    return hit ? hit.replace(/[¿?¡!.,;]+/g, '') : w;
  }).join(' ');
  return restored.charAt(0).toUpperCase() + restored.slice(1);
}

/**
 * "Limpiar toda la casa me lleva una hora y media" ->
 * { name: 'Limpiar toda la casa', durationMin: 90, category: 'hogar', ... }
 */
export function parseTaskText(text, today) {
  const t = normalize(text);
  const time = parseTime(text);
  const dur = parseDuration(time ? t.replace(time.match, ' ') : t);
  const when = parseWhen(text, today);
  const out = { raw: text };
  if (dur) {
    out.durationMin = dur.minutes;
    out.durationLocked = /\b(me lleva|tardo|me tarda|me llevan)\b/.test(t); // dato que da el usuario
  }
  if (time) out.fixedTime = time.time;
  if (when && when.recurrence) out.recurrence = when.recurrence;
  if (when && when.date) out.date = when.date;
  if (!time) {
    if (/\b(a|por|en) la manana\b/.test(t)) out.preferred = 'manana';
    else if (/\b(a|por|en) la tarde\b/.test(t)) out.preferred = 'tarde';
    else if (/\b(a|por|en) la noche\b/.test(t)) out.preferred = 'noche';
  }
  if (/\b(urgente|importante|prioridad alta)\b/.test(t)) out.priority = 1;
  else if (/\b(sin apuro|prioridad baja|cuando pueda)\b/.test(t)) out.priority = 3;
  for (const [cat, re] of CATEGORY_WORDS) {
    if (re.test(t)) {
      out.category = cat;
      break;
    }
  }
  if (out.category === 'hogar' || out.category === 'compras') {
    for (const [area, re] of AREA_WORDS) if (re.test(t)) {
      out.area = area;
      break;
    }
  }
  const travel = /\b(?:con|incluye|incluyendo) (?:el )?(?:viaje|traslado)s? de ([\w ]+?)(?: minutos| min)\b/.exec(t);
  if (travel) out.travelMin = num(travel[1]);
  out.name = cleanName(text, [dur && dur.match, time && time.match, travel && travel[0], /\b(?:con|incluye|incluyendo) (?:el )?(?:viaje|traslado)s?\b/g]);
  if (!out.name) out.name = 'Tarea nueva';
  return out;
}

// ---------- Comandos ----------

const COMMANDS = [
  ['start', /\b(ya empece|empece|empezar|empecemos|arranco|arranque|vamos|dale empezamos|comenzar|comence)\b/],
  ['done', /\b(termine|listo|ya esta|hecho|complete|ya lo hice|finalice)\b/],
  ['more', /\b(necesito|dame|quiero) (\w+(?: y \w+)?) minutos? mas\b|\b(\w+) minutos? mas\b|\bun rato mas\b/],
  ['cant', /\b(no puedo|ahora no|no voy a poder|no llego)\b/],
  ['tired', /\b(estoy cansad[oa]|me siento cansad[oa]|no doy mas|agotad[oa]|sin energia)\b/],
  ['next', /\b(que sigue|que tengo que hacer|que hago ahora|que me toca|proxima tarea|siguiente)\b/],
  ['replan', /\b(reorganiza|reorganizar|reacomoda|reacomodar|replanifica|rearma) (?:mi )?(?:el )?dia\b|\breorganiza\b/],
  ['postpone', /\b(posponer|pospone|posponela|despues|mas tarde|en un rato)\b/],
  ['today', /\b(que tengo hoy|como es mi dia|resumen del dia|mi dia|buen dia)\b/],
  ['pause', /\b(pausa|pausar|frena|parar un momento)\b/],
];

export function parseCommand(text) {
  const t = normalize(text);
  if (!t) return { intent: 'unknown' };
  for (const [intent, re] of COMMANDS) {
    const m = re.exec(t);
    if (!m) continue;
    if (intent === 'more') {
      const word = m[2] || m[3];
      const n = word ? num(word) : 10;
      return { intent, minutes: n || 10 };
    }
    if (intent === 'postpone') {
      const d = parseDuration(text);
      return { intent, minutes: d ? d.minutes : null };
    }
    return { intent };
  }
  // Si parece una tarea nueva ("agregá ...", "recordame ...", o trae duración/hora), se crea.
  if (/^(agrega|agregar|anota|anotame|recordame|agenda|agendame|nueva tarea|tengo que|hay que)\b/.test(t) || parseDuration(text) || parseTime(text)) {
    return { intent: 'add', text };
  }
  return { intent: 'unknown' };
}
