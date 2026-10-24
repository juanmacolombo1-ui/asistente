// Exportación al Calendario del iPhone (formato .ics). Las alarmas del Calendario
// suenan con el teléfono bloqueado y la app cerrada, cosa que una web app no puede garantizar.
import { keyToDate } from './time.js';

function utc(date, min) {
  const d = keyToDate(date, min);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function esc(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}

function fold(line) {
  const out = [];
  let cur = line;
  while (cur.length > 74) {
    out.push(cur.slice(0, 74));
    cur = ' ' + cur.slice(74);
  }
  out.push(cur);
  return out.join('\r\n');
}

function alarm(minutesBefore, text) {
  return [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${esc(text)}`,
    `TRIGGER:${minutesBefore > 0 ? `-PT${minutesBefore}M` : 'PT0S'}`,
    'END:VALARM',
  ];
}

/**
 * @param {Array} plans  planes generados por planDay
 * @param {object} opts  { leadMin, includeWork, stamp }
 */
export function buildICS(plans, { leadMin = 5, includeWork = true, stamp = new Date() } = {}) {
  const now = stamp.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Asistente Personal//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Asistente'];
  for (const plan of plans) {
    for (const b of plan.blocks) {
      const isTask = b.type === 'task' && !b.done && b.status !== 'completada';
      const isWork = includeWork && b.type === 'work';
      if (!isTask && !isWork) continue;
      const uid = `${isTask ? b.key : plan.date + '-trabajo'}${b.part ? '-' + b.part : ''}@asistente`;
      const title = isTask ? b.label + (b.parts ? ` (${b.part}/${b.parts})` : '') : b.label;
      const desc = isTask
        ? `Duración estimada: ${b.durationMin} min.${b.taskStart > b.start ? ' Incluye preparación y traslado.' : ''}`
        : 'Turno de trabajo.';
      lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${now}`, `DTSTART:${utc(plan.date, b.start)}`, `DTEND:${utc(plan.date, b.end)}`,
        `SUMMARY:${esc(title)}`, `DESCRIPTION:${esc(desc)}`);
      if (isTask) {
        if (leadMin > 0) lines.push(...alarm(leadMin, `En ${leadMin} min: ${title}`));
        lines.push(...alarm(0, `Es hora: ${title}`));
      } else {
        const leave = plan.blocks.find((x) => x.type === 'travel' && x.label === 'Viaje al trabajo');
        if (leave) lines.push(...alarm(b.start - leave.start, 'Hora de salir para el trabajo'));
      }
      lines.push('END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
