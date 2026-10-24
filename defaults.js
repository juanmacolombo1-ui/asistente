// Configuración por defecto y modelo de datos.
import { dateKey, mondayOf } from './time.js';

export const CATEGORIES = [
  { id: 'hogar', label: 'Hogar', icon: '🏠' },
  { id: 'compras', label: 'Compras', icon: '🛒' },
  { id: 'trabajo', label: 'Trabajo', icon: '💼' },
  { id: 'gimnasio', label: 'Gimnasio', icon: '🏋️' },
  { id: 'salud', label: 'Salud', icon: '🩺' },
  { id: 'pareja', label: 'Pareja', icon: '❤️' },
  { id: 'proyecto', label: 'Proyecto personal', icon: '🚀' },
  { id: 'administracion', label: 'Administración', icon: '📄' },
  { id: 'descanso', label: 'Descanso', icon: '☕' },
];

export const HOME_AREAS = ['Limpieza general', 'Cocina', 'Baño', 'Ropa', 'Placares', 'Orden general',
  'Compras de alimentos', 'Productos de limpieza', 'Cajas de los gatos', 'Otra'];

export const PRIORITIES = [
  { id: 1, label: 'Alta' },
  { id: 2, label: 'Media' },
  { id: 3, label: 'Baja' },
];

export const STATUS = {
  pendiente: 'Pendiente',
  en_curso: 'En curso',
  completada: 'Completada',
  pospuesta: 'Pospuesta',
  cancelada: 'Cancelada',
};

export const REASONS = [
  { id: 'no_empece', label: 'No empecé' },
  { id: 'distraccion', label: 'Me distraje' },
  { id: 'mas_tiempo', label: 'Llevó más tiempo' },
  { id: 'imprevisto', label: 'Surgió un imprevisto' },
  { id: 'cansado', label: 'Estaba muy cansado' },
  { id: 'muy_grande', label: 'Era demasiado grande' },
];

export const DAY_TYPES = {
  manana: 'Turno mañana',
  tarde: 'Turno tarde',
  sabado: 'Sábado de trabajo',
  libre: 'Día libre',
  vacaciones: 'Vacaciones',
};

export function defaultSettings(today = dateKey()) {
  return {
    version: 1,
    shifts: {
      manana: { start: '07:30', end: '14:45' },
      tarde: { start: '14:30', end: '20:30' },
      sabado: { start: '09:30', end: '15:30' },
    },
    saturdayWithTarde: true, // en semanas de turno tarde también se trabaja el sábado
    travelMin: 30, // se usa el máximo estimado (20–30) para no llegar tarde
    prepMin: 25, // prepararse antes de salir
    workDays: [1, 2, 3, 4, 5],
    rotation: { enabled: true, anchorMonday: mondayOf(today), firstShift: 'manana' },
    weekShifts: {}, // lunes (YYYY-MM-DD) -> 'manana' | 'tarde'
    overrides: {}, // fecha -> 'manana' | 'tarde' | 'libre' | 'vacaciones'
    profiles: {
      manana: {
        wake: '06:10', bed: '22:30',
        meals: [
          { name: 'Desayuno', time: '06:15', dur: 20 },
          { name: 'Almuerzo', time: '15:30', dur: 40 },
          { name: 'Cena', time: '21:00', dur: 40 },
        ],
      },
      tarde: {
        wake: '08:30', bed: '00:30',
        meals: [
          { name: 'Desayuno', time: '08:45', dur: 25 },
          { name: 'Almuerzo', time: '12:45', dur: 40 },
          { name: 'Cena', time: '21:15', dur: 40 },
        ],
      },
      sabado: {
        wake: '07:45', bed: '00:30',
        meals: [
          { name: 'Desayuno', time: '08:00', dur: 25 },
          { name: 'Almuerzo', time: '16:15', dur: 40 },
          { name: 'Cena', time: '21:30', dur: 45 },
        ],
      },
      libre: {
        wake: '09:00', bed: '00:30',
        meals: [
          { name: 'Desayuno', time: '09:15', dur: 30 },
          { name: 'Almuerzo', time: '13:30', dur: 45 },
          { name: 'Cena', time: '21:30', dur: 45 },
        ],
      },
    },
    bufferPct: 20, // porcentaje del tiempo libre que nunca se llena
    gapMin: 10, // separación mínima entre actividades
    alarm: {
      leadMin: 5,
      repeatEveryMin: 3,
      maxRepeats: 3,
      sound: 'campana',
      volume: 0.9,
      vibrate: true,
      voice: true,
      voiceRate: 1,
      leaveAlert: true,
    },
    focus: { defaultMin: 25, breakMin: 5 },
    projects: { maxActive: 2 },
    lastBackupAt: null,
  };
}

export function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function newTask(partial = {}) {
  return {
    id: newId(),
    name: '',
    category: 'hogar',
    area: null, // sub-área del módulo hogar
    durationMin: 30,
    durationLocked: false, // true = la fijó el usuario: el sistema no la cambia solo
    activeMin: null, // trabajo activo si es menor que la duración total (ej. lavarropas)
    priority: 2,
    recurrence: { type: 'once', days: [], interval: 1, dayOfMonth: null },
    date: dateKey(),
    startDate: dateKey(),
    fixedTime: null, // 'HH:MM' -> compromiso fijo; null -> flexible
    preferred: null, // 'manana' | 'tarde' | 'noche'
    earliest: null,
    deadline: null,
    onlyDayType: 'any', // 'any' | 'manana' | 'tarde' | 'libre' | 'laboral'
    prepMin: 0,
    travelMin: 0,
    steps: [],
    dependsOn: null,
    splittable: false,
    minChunk: 25,
    projectId: null,
    important: false,
    notes: '',
    archived: false,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

export function newProject(partial = {}) {
  return {
    id: newId(),
    name: '',
    objective: '',
    nextStep: '',
    tasks: [], // {id, text, done, estMin}
    targetDate: null,
    main: false,
    active: true,
    sessions: [], // {date, minutes, note, nextStep}
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

/** Tareas sugeridas del módulo hogar. Las duraciones son editables. */
export function homePresets(today = dateKey()) {
  const base = { category: 'hogar', startDate: today, date: today };
  return [
    newTask({ ...base, name: 'Limpieza completa de la casa', area: 'Limpieza general', durationMin: 90, durationLocked: true,
      recurrence: { type: 'weekly', days: [6], interval: 1 }, onlyDayType: 'any', preferred: 'manana',
      steps: [{ text: 'Juntar y ordenar', done: false }, { text: 'Barrer', done: false }, { text: 'Pasar el trapo', done: false }, { text: 'Baño y cocina', done: false }] }),
    newTask({ ...base, name: 'Limpiar las cajas de los gatos', area: 'Cajas de los gatos', durationMin: 10,
      recurrence: { type: 'daily', days: [], interval: 1 }, priority: 1 }),
    newTask({ ...base, name: 'Lavar la ropa', area: 'Ropa', durationMin: 90, activeMin: 15,
      recurrence: { type: 'weekly', days: [3, 0], interval: 1 }, notes: 'El ciclo corre solo; al terminar, colgar la ropa.' }),
    newTask({ ...base, name: 'Cocina: lavar y ordenar', area: 'Cocina', durationMin: 20,
      recurrence: { type: 'daily', days: [], interval: 1 } }),
    newTask({ ...base, name: 'Limpiar el baño', area: 'Baño', durationMin: 30,
      recurrence: { type: 'weekly', days: [3], interval: 1 } }),
    newTask({ ...base, name: 'Compras del supermercado', category: 'compras', area: 'Compras de alimentos', durationMin: 45, travelMin: 10,
      recurrence: { type: 'weekly', days: [5], interval: 1 }, notes: 'Incluye ida y vuelta.' }),
    newTask({ ...base, name: 'Ordenar placares', area: 'Placares', durationMin: 45, priority: 3,
      recurrence: { type: 'monthly', days: [], interval: 1, dayOfMonth: 1 }, splittable: true }),
  ];
}

export function emptyState(today = dateKey()) {
  return {
    schema: 1,
    settings: defaultSettings(today),
    tasks: [],
    occ: {}, // `${taskId}@${fecha}` -> instancia del día
    projects: [],
    focus: [], // sesiones de concentración
    shopping: [], // lista de compras {id, text, done, doneAt}
    durationLog: {}, // taskId -> [{date, est, actual}]
    alarmLog: {}, // claves de alarmas ya disparadas
  };
}
