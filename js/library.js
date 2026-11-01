// Operações de manutenção da biblioteca: juntar músicas, reordenar páginas, padronizar bandas
// e achar músicas que parecem repetidas. Sem tela: só dados (db.js), para poder ser testado.
import * as db from './db.js';
import { NO_BAND, fold, loose, bandNames } from './names.js';

// ---------- juntar ----------

// Junta as páginas de `sourceId` na música `targetId` (que mantém banda e título).
// where: 'end' = páginas da origem depois das do destino; 'start' = antes.
// As páginas são renumeradas 1..N, os repertórios passam a apontar para o destino
// e a música de origem é excluída (a exclusão também vale na sincronização).
export async function mergeSongs(targetId, sourceId, where = 'end') {
  if (targetId === sourceId) throw new Error('Escolha duas músicas diferentes.');
  const target = await db.get('songs', targetId);
  const source = await db.get('songs', sourceId);
  if (!target || !source) throw new Error('Música não encontrada.');

  const tp = await db.getPages(targetId);
  const sp = await db.getPages(sourceId);
  const blobs = (where === 'start' ? [...sp, ...tp] : [...tp, ...sp]).map((p) => p.blob);

  for (let i = 0; i < blobs.length; i++) await db.putPage(targetId, i + 1, blobs[i]);
  for (const p of tp) if (p.n > blobs.length) await db.del('pages', p.id); // sobra de numeração com buracos

  target.pageCount = blobs.length;
  target.updatedAt = Date.now();
  await db.put('songs', target);

  for (const sl of await db.getAll('setlists')) {
    if (!sl.items.includes(sourceId)) continue;
    let seen = false;
    sl.items = sl.items
      .map((id) => (id === sourceId ? targetId : id))
      .filter((id) => {
        if (id !== targetId) return true;
        if (seen) return false; // não repete a música junta no mesmo repertório
        seen = true;
        return true;
      });
    sl.updatedAt = Date.now();
    await db.put('setlists', sl);
  }

  await db.deleteSong(sourceId); // apaga a antiga e registra a exclusão para os outros aparelhos
  return { pages: blobs.length };
}

// ---------- reordenar páginas ----------

// order = números das páginas atuais na nova ordem, ex.: [2, 1, 3].
export async function reorderPages(songId, order) {
  const song = await db.get('songs', songId);
  const pages = await db.getPages(songId);
  const byN = new Map(pages.map((p) => [p.n, p]));
  if (!song || order.length !== pages.length || order.some((n) => !byN.has(n)) || new Set(order).size !== order.length) {
    throw new Error('Ordem de páginas inválida.');
  }
  const blobs = order.map((n) => byN.get(n).blob);
  for (let i = 0; i < blobs.length; i++) await db.putPage(songId, i + 1, blobs[i]);
  for (const p of pages) if (p.n > blobs.length) await db.del('pages', p.id);
  song.pageCount = blobs.length;
  song.updatedAt = Date.now();
  await db.put('songs', song);
}

// ---------- bandas ----------

// Deixa cada banda com uma grafia só ("legião urbana" + "Legião Urbana" -> "Legião Urbana").
// Retorna quantas músicas mudaram.
export async function standardizeBands() {
  const songs = await db.getAll('songs');
  const names = bandNames(songs);
  let changed = 0;
  for (const s of songs) {
    const want = names.get(fold(s.band));
    if (want && want !== s.band) {
      s.band = want;
      s.updatedAt = Date.now();
      await db.put('songs', s); // a chave não muda: já ignora maiúsculas
      changed++;
    }
  }
  return changed;
}

// Renomeia a banda em todas as músicas que a usam (qualquer grafia). Retorna quantas mudaram.
export async function renameBand(oldBand, newName) {
  const k = fold(oldBand);
  let changed = 0;
  for (const s of await db.getAll('songs')) {
    if (fold(s.band) !== k || s.band === newName) continue;
    s.band = newName;
    s.updatedAt = Date.now();
    await db.put('songs', s);
    changed++;
  }
  return changed;
}

// Decide a banda final ao editar uma música:
// - só mudou a grafia da própria banda -> vale a digitada, para todas as músicas dela (renameAll);
// - foi para uma banda que já existe com outra grafia -> usa a que já existe.
export async function resolveBand(song, typed) {
  const k = fold(typed);
  if (k === fold(NO_BAND)) return { band: NO_BAND, renameAll: false };
  if (k === fold(song.band)) return { band: typed, renameAll: typed !== song.band };
  const others = (await db.getAll('songs')).filter((s) => s.id !== song.id && fold(s.band) === k);
  if (others.length) {
    const names = bandNames(others);
    return { band: names.get(k), renameAll: false };
  }
  return { band: typed, renameAll: false };
}

// ---------- duplicadas ----------

// Pares de músicas que parecem ser a mesma, com o motivo.
// Não junta nada: só aponta para a pessoa decidir.
export function findDuplicates(songs) {
  const pairs = [];
  const seen = new Set();
  const add = (a, b, reason) => {
    const id = [a.id, b.id].sort().join('|');
    if (seen.has(id)) return;
    seen.add(id);
    pairs.push({ a, b, reason });
  };
  const info = songs.map((s) => ({ s, band: loose(s.band), title: loose(s.title) }));
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      const x = info[i];
      const y = info[j];
      if (x.band === y.title && x.title === y.band && x.title && x.band) {
        add(x.s, y.s, 'banda e título trocados');
      } else if (x.title === y.title && x.band === y.band) {
        add(x.s, y.s, 'mesmo nome com pontuação diferente');
      } else if (x.title === y.title && (x.s.band === NO_BAND) !== (y.s.band === NO_BAND)) {
        add(x.s, y.s, 'uma delas está sem banda');
      }
    }
  }
  return pairs;
}
