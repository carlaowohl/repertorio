// Camada de armazenamento local (IndexedDB).
// songs:    { id, band, title, key, pageCount, createdAt, updatedAt }
// pages:    { id: `${songId}#${n}`, songId, n, blob }
// setlists: { id, name, items: [songId], createdAt, updatedAt }

const DB_NAME = 'repertorio';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const songs = db.createObjectStore('songs', { keyPath: 'id' });
      songs.createIndex('key', 'key', { unique: true });
      const pages = db.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('songId', 'songId');
      db.createObjectStore('setlists', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const songKey = (band, title) =>
  `${band}|${title}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export async function getAll(name) {
  return promisify((await store(name)).getAll());
}

export async function get(name, id) {
  return promisify((await store(name)).get(id));
}

export async function put(name, value) {
  return promisify((await store(name, 'readwrite')).put(value));
}

// Como put, mas só resolve quando a transação foi gravada no disco.
// Usado em cargas grandes (restaurar backup) para não acumular gravações pendentes na memória.
export async function putDurable(name, value) {
  const db = await open();
  const tx = db.transaction(name, 'readwrite');
  tx.objectStore(name).put(value);
  return txDone(tx);
}

// Exclusões feitas neste aparelho, para a sincronização apagar também nos outros.
// { songs: { id: timestamp }, setlists: { id: timestamp } }
const TOMB_KEY = 'repertorio.tombstones';

export function getTombstones() {
  try {
    const t = JSON.parse(localStorage.getItem(TOMB_KEY) || '{}');
    return { songs: t.songs || {}, setlists: t.setlists || {} };
  } catch {
    return { songs: {}, setlists: {} };
  }
}

export function saveTombstones(t) {
  try { localStorage.setItem(TOMB_KEY, JSON.stringify(t)); } catch { /* sem localStorage: a exclusão fica só neste aparelho */ }
}

function addTombstone(kind, id) {
  const t = getTombstones();
  t[kind][id] = Date.now();
  saveTombstones(t);
}

export async function del(name, id, remember = true) {
  if (name === 'setlists' && remember) addTombstone('setlists', id);
  return promisify((await store(name, 'readwrite')).delete(id));
}

export async function findSongByKey(key) {
  const s = await store('songs');
  return promisify(s.index('key').get(key));
}

export async function getPages(songId) {
  const s = await store('pages');
  const pages = await promisify(s.index('songId').getAll(songId));
  return pages.sort((a, b) => a.n - b.n);
}

export async function putPage(songId, n, blob) {
  return put('pages', { id: `${songId}#${n}`, songId, n, blob });
}

// remember=false é usado pela sincronização, que aplica exclusões vindas de outro aparelho.
export async function deleteSong(songId, remember = true) {
  if (remember) addTombstone('songs', songId);
  const db = await open();
  const tx = db.transaction(['songs', 'pages', 'setlists'], 'readwrite');
  tx.objectStore('songs').delete(songId);
  const pageStore = tx.objectStore('pages');
  const keys = await promisify(pageStore.index('songId').getAllKeys(songId));
  keys.forEach((k) => pageStore.delete(k));
  const setlistStore = tx.objectStore('setlists');
  const setlists = await promisify(setlistStore.getAll());
  setlists.forEach((sl) => {
    if (sl.items.includes(songId)) {
      sl.items = sl.items.filter((id) => id !== songId);
      setlistStore.put(sl);
    }
  });
  return txDone(tx);
}

export async function clearAll() {
  const db = await open();
  const tx = db.transaction(['songs', 'pages', 'setlists'], 'readwrite');
  ['songs', 'pages', 'setlists'].forEach((n) => tx.objectStore(n).clear());
  return txDone(tx);
}
