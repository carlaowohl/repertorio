// Sincronização entre aparelhos pela pasta privada do app no Google Drive (appDataFolder).
// Só este app enxerga essa pasta; ela não aparece nos arquivos do Drive.
// Drive: state.json (músicas, repertórios, exclusões) + uma imagem por página (p_<musica>_<n>.jpg).
// Cada música/repertório vale pela versão com updatedAt mais recente; exclusões valem se forem mais novas.
import * as db from './db.js';

const CLIENT_ID = '547712741683-3qmf4g1v441ogctddhdc3hffu63gd7g6.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const STATE_NAME = 'state.json';
const LAST_KEY = 'repertorio.lastSync';
const HINT_KEY = 'repertorio.googleHint';
const PAGE_RE = /^p_(.+)_(\d+)\.jpg$/;

// ---------- mesclagem (pura, sem rede) ----------

const emptyState = () => ({ songs: [], setlists: [], tombstones: { songs: {}, setlists: {} } });

export function mergeStates(local, remote) {
  remote = remote || emptyState();
  const tomb = { songs: {}, setlists: {} };
  for (const kind of ['songs', 'setlists']) {
    for (const src of [local.tombstones?.[kind] || {}, remote.tombstones?.[kind] || {}]) {
      for (const [id, t] of Object.entries(src)) tomb[kind][id] = Math.max(tomb[kind][id] || 0, t);
    }
  }

  const pick = (kind) => {
    const L = new Map((local[kind] || []).map((x) => [x.id, x]));
    const R = new Map((remote[kind] || []).map((x) => [x.id, x]));
    const out = new Map();
    const winner = new Map();
    for (const id of new Set([...L.keys(), ...R.keys()])) {
      const l = L.get(id);
      const r = R.get(id);
      const lu = l?.updatedAt || 0;
      const ru = r?.updatedAt || 0;
      if (tomb[kind][id] && tomb[kind][id] >= Math.max(lu, ru)) continue; // apagado depois da última edição
      let w = 'same';
      let rec = l;
      if (!r) w = 'local';
      else if (!l || ru > lu) { w = 'remote'; rec = r; }
      else if (lu > ru) w = 'local';
      out.set(id, rec);
      winner.set(id, w);
    }
    return { out, winner };
  };

  const songs = pick('songs');
  const setlists = pick('setlists');

  // Mesma música (banda + título) criada com ids diferentes em dois aparelhos: fica o menor id.
  const redirect = new Map();
  const byKey = new Map();
  for (const s of songs.out.values()) {
    const cur = byKey.get(s.key);
    if (!cur) { byKey.set(s.key, s.id); continue; }
    const canon = cur < s.id ? cur : s.id;
    const other = cur < s.id ? s.id : cur;
    redirect.set(other, canon);
    byKey.set(s.key, canon);
  }
  const resolve = (id) => { while (redirect.has(id)) id = redirect.get(id); return id; };
  for (const other of redirect.keys()) { songs.out.delete(other); songs.winner.delete(other); }

  for (const sl of setlists.out.values()) {
    const items = [];
    for (const id of sl.items) {
      const to = resolve(id);
      if (!items.includes(to)) items.push(to);
    }
    if (items.length !== sl.items.length || items.some((x, i) => x !== sl.items[i])) {
      setlists.out.set(sl.id, { ...sl, items });
    }
  }

  return {
    songs: [...songs.out.values()],
    setlists: [...setlists.out.values()],
    tombstones: tomb,
    songWinner: songs.winner,
    setlistWinner: setlists.winner,
  };
}

// ---------- Google: login e chamadas ----------

let token = null;
let tokenExp = 0;

function loadGis() {
  return new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => res();
    s.onerror = () => rej(new Error('Sem internet para entrar no Google.'));
    document.head.appendChild(s);
  });
}

async function getToken(force = false) {
  if (!force && token && Date.now() < tokenExp - 60000) return token;
  await loadGis();
  let hint = false;
  try { hint = !!localStorage.getItem(HINT_KEY); } catch { /* sem localStorage */ }
  return new Promise((res, rej) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return rej(new Error(`Login do Google falhou (${r.error}).`));
        token = r.access_token;
        tokenExp = Date.now() + (r.expires_in || 3600) * 1000;
        try { localStorage.setItem(HINT_KEY, '1'); } catch { /* ignora */ }
        res(token);
      },
      error_callback: (e) => rej(new Error(e.type === 'popup_closed' ? 'Login do Google cancelado.' : `Login do Google falhou (${e.type || 'erro'}).`)),
    });
    client.requestAccessToken({ prompt: hint ? '' : 'consent' });
  });
}

async function gfetch(url, opts = {}, retry = true) {
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${await getToken()}` } });
  if (res.status === 401 && retry) { token = null; await getToken(true); return gfetch(url, opts, false); }
  if (!res.ok) throw new Error(`Drive respondeu ${res.status}${res.status === 403 ? ' (sem permissão ou cota)' : ''}`);
  return res;
}

async function listFiles() {
  const files = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({
      spaces: 'appDataFolder',
      pageSize: '1000',
      fields: 'nextPageToken,files(id,name,modifiedTime)',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const data = await (await gfetch(`${API}/files?${q}`)).json();
    files.push(...data.files);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function uploadFile(name, blob, mime, existingId) {
  if (existingId) {
    await gfetch(`${UPLOAD}/files/${existingId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': mime }, body: blob });
    return;
  }
  const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
  const body = new Blob([`--rp\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--rp\r\nContent-Type: ${mime}\r\n\r\n`, blob, '\r\n--rp--']);
  await gfetch(`${UPLOAD}/files?uploadType=multipart`, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=rp' }, body });
}

async function downloadBlob(id) {
  return (await gfetch(`${API}/files/${id}?alt=media`)).blob();
}

async function runPool(tasks, size, onTick) {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      await tasks[i]();
      onTick?.(++done, tasks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
}

// ---------- sincronização ----------

export function lastSyncText() {
  try {
    const t = Number(localStorage.getItem(LAST_KEY));
    return t ? new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
  } catch {
    return '';
  }
}

export async function syncAll(progress = () => {}) {
  progress('Entrando na conta Google…');
  await getToken();

  progress('Lendo o Drive…');
  const files = await listFiles();
  const stateFile = files.find((f) => f.name === STATE_NAME);
  const remote = stateFile ? await (await gfetch(`${API}/files/${stateFile.id}?alt=media`)).json() : null;

  const [songs, setlists] = await Promise.all([db.getAll('songs'), db.getAll('setlists')]);
  const m = mergeStates({ songs, setlists, tombstones: db.getTombstones() }, remote);

  // Aplica neste aparelho: exclusões e versões mais novas.
  progress('Atualizando este aparelho…');
  const keepSongs = new Set(m.songs.map((s) => s.id));
  const keepSetlists = new Set(m.setlists.map((s) => s.id));
  for (const s of songs) if (!keepSongs.has(s.id)) await db.deleteSong(s.id, false);
  for (const sl of setlists) if (!keepSetlists.has(sl.id)) await db.del('setlists', sl.id, false);
  for (const s of m.songs) if (m.songWinner.get(s.id) === 'remote') await db.put('songs', s);
  for (const sl of m.setlists) await db.put('setlists', sl);
  db.saveTombstones(m.tombstones);

  // Páginas (imagens).
  const remotePages = new Map(); // songId -> Map(n -> arquivo)
  for (const f of files) {
    const p = PAGE_RE.exec(f.name);
    if (!p) continue;
    if (!remotePages.has(p[1])) remotePages.set(p[1], new Map());
    remotePages.get(p[1]).set(Number(p[2]), f);
  }

  const ups = [];
  const downs = [];
  const orphans = [];
  for (const s of m.songs) {
    const w = m.songWinner.get(s.id);
    const rp = remotePages.get(s.id) || new Map();
    const lp = new Map((await db.getPages(s.id)).map((p) => [p.n, p]));
    if (w !== 'remote') {
      for (const [n, p] of lp) {
        const f = rp.get(n);
        const stale = f && w === 'local' && Date.parse(f.modifiedTime) < (s.updatedAt || 0);
        if (!f || stale) ups.push(() => uploadFile(`p_${s.id}_${n}.jpg`, p.blob, 'image/jpeg', f?.id));
      }
    }
    for (const [n, f] of rp) {
      if (w === 'remote' || !lp.has(n)) downs.push(async () => db.putPage(s.id, n, await downloadBlob(f.id)));
    }
  }
  for (const [songId, pages] of remotePages) {
    if (!keepSongs.has(songId)) for (const f of pages.values()) orphans.push(() => gfetch(`${API}/files/${f.id}`, { method: 'DELETE' }));
  }

  await runPool(ups, 3, (i, n) => progress(`Enviando páginas… ${i}/${n}`));
  await runPool(downs, 3, (i, n) => progress(`Baixando páginas… ${i}/${n}`));
  await runPool(orphans, 3);

  progress('Gravando o estado no Drive…');
  const state = { version: 1, savedAt: Date.now(), songs: m.songs, setlists: m.setlists, tombstones: m.tombstones };
  await uploadFile(STATE_NAME, new Blob([JSON.stringify(state)], { type: 'application/json' }), 'application/json', stateFile?.id);

  try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch { /* ignora */ }
  return { songs: m.songs.length, setlists: m.setlists.length, enviadas: ups.length, baixadas: downs.length };
}
