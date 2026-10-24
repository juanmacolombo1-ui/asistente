// Persistencia local (IndexedDB) con copias de seguridad automáticas y exportación/importación.
// Los datos viven solo en el teléfono: no se envían a ningún servidor.
import { emptyState, defaultSettings } from './defaults.js';

const DB_NAME = 'asistente';
const DB_VERSION = 1;
const MAX_SNAPSHOTS = 7;
const LS_KEY = 'asistente-state-fallback';

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB no disponible'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'at' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Completa campos faltantes cuando cambia la versión de los datos. */
export function migrate(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const st = { ...base, ...raw };
  const defs = defaultSettings();
  st.settings = { ...defs, ...(raw.settings || {}) };
  for (const k of ['shifts', 'alarm', 'focus', 'projects', 'rotation']) st.settings[k] = { ...defs[k], ...((raw.settings || {})[k] || {}) };
  st.settings.profiles = { ...defs.profiles, ...((raw.settings || {}).profiles || {}) };
  for (const k of ['tasks', 'projects', 'focus']) if (!Array.isArray(st[k])) st[k] = [];
  for (const k of ['occ', 'durationLog', 'alarmLog']) if (!st[k] || typeof st[k] !== 'object') st[k] = {};
  return st;
}

export function validateImport(obj) {
  if (!obj || typeof obj !== 'object') return 'El archivo no tiene un formato válido.';
  if (!Array.isArray(obj.tasks) || !obj.settings) return 'El archivo no parece ser un respaldo del asistente.';
  return null;
}

export class Store {
  constructor() {
    this.db = null;
    this.mode = 'idb';
    this.lastSnapshotAt = 0;
    this.timer = null;
  }

  async init() {
    try {
      this.db = await openDB();
    } catch {
      this.mode = 'localStorage';
    }
    try {
      if (navigator.storage && navigator.storage.persist) this.persisted = await navigator.storage.persist();
    } catch { /* sin soporte */ }
    return this.load();
  }

  async load() {
    let raw = null;
    try {
      if (this.mode === 'idb') raw = await tx(this.db, 'kv', 'readonly', (s) => reqP(s.get('state')));
      else raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    } catch (e) {
      console.error('No se pudo leer el estado, intento con la última copia', e);
      const snaps = await this.listSnapshots().catch(() => []);
      if (snaps.length) raw = snaps[0].state;
    }
    return migrate(raw);
  }

  /** Guarda con una pequeña demora para agrupar cambios seguidos. */
  save(state, immediate = false) {
    clearTimeout(this.timer);
    const doSave = () => this.saveNow(state).catch((e) => console.error('Error al guardar', e));
    if (immediate) return doSave();
    this.timer = setTimeout(doSave, 300);
    return Promise.resolve();
  }

  async saveNow(state) {
    const copy = JSON.parse(JSON.stringify(state));
    if (this.mode === 'idb') {
      await tx(this.db, 'kv', 'readwrite', (s) => s.put(copy, 'state'));
      if (Date.now() - this.lastSnapshotAt > 6 * 3600 * 1000) {
        this.lastSnapshotAt = Date.now();
        await this.snapshot(copy);
      }
    } else {
      localStorage.setItem(LS_KEY, JSON.stringify(copy));
    }
  }

  async snapshot(state) {
    if (this.mode !== 'idb') return;
    await tx(this.db, 'snapshots', 'readwrite', (s) => s.put({ at: Date.now(), state }));
    const all = await this.listSnapshots();
    const extra = all.slice(MAX_SNAPSHOTS);
    if (extra.length) await tx(this.db, 'snapshots', 'readwrite', (s) => extra.forEach((x) => s.delete(x.at)));
  }

  async listSnapshots() {
    if (this.mode !== 'idb') return [];
    const all = await tx(this.db, 'snapshots', 'readonly', (s) => reqP(s.getAll()));
    return (all || []).sort((a, b) => b.at - a.at);
  }
}

export function exportJSON(state) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), app: 'asistente-personal', ...state }, null, 2);
}
