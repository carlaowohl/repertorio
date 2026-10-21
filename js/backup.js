// Backup completo num único arquivo .json (músicas, imagens e repertórios).
// Serve para trocar de tablet ou levar para outro aparelho até a sincronização existir.
import * as db from './db.js';

const blobToDataURL = (blob) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

const dataURLToBlob = async (url) => (await fetch(url)).blob();

export async function exportBackup() {
  const [songs, pages, setlists] = await Promise.all([
    db.getAll('songs'),
    db.getAll('pages'),
    db.getAll('setlists'),
  ]);
  const packedPages = [];
  for (const p of pages) {
    packedPages.push({ id: p.id, songId: p.songId, n: p.n, data: await blobToDataURL(p.blob) });
  }
  const payload = { app: 'repertorio', version: 1, exportedAt: new Date().toISOString(), songs, pages: packedPages, setlists };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `repertorio-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Mescla o backup com o que já existe (mesmo id = substitui).
export async function importBackup(file) {
  const payload = JSON.parse(await file.text());
  if (payload.app !== 'repertorio') throw new Error('Esse arquivo não é um backup do Repertório.');
  for (const s of payload.songs) await db.put('songs', s);
  for (const p of payload.pages) {
    await db.put('pages', { id: p.id, songId: p.songId, n: p.n, blob: await dataURLToBlob(p.data) });
  }
  for (const sl of payload.setlists) await db.put('setlists', sl);
  return { songs: payload.songs.length, setlists: payload.setlists.length };
}
