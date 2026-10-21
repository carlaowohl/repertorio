// Backup completo num único arquivo .json (músicas, imagens e repertórios).
// Serve para trocar de tablet ou levar para outro aparelho até a sincronização existir.
// Exporta e restaura em fluxo, uma página por vez, para funcionar com backups de centenas de MB no tablet.
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
  // Cada página vira um Blob pequeno na hora, para o texto não acumular na memória.
  const parts = [
    `{"app":"repertorio","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"songs":${JSON.stringify(songs)},"pages":[`,
  ];
  let first = true;
  for (const p of pages) {
    const item = JSON.stringify({ id: p.id, songId: p.songId, n: p.n, data: await blobToDataURL(p.blob) });
    parts.push(new Blob([(first ? '' : ',') + item]));
    first = false;
  }
  parts.push(`],"setlists":${JSON.stringify(setlists)}}`);
  const blob = new Blob(parts, { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `repertorio-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// Lê o JSON do backup aos poucos. Entrega cada valor simples do topo ({ key, value })
// e cada elemento dos arrays do topo ({ key, value }), sem nunca segurar o arquivo inteiro.
export async function* scanBackup(file) {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  const re = /["{}\[\]:,]/g;
  let s = '';
  let scanned = 0; // até onde `s` já foi lido
  let depth = 0;
  let lastStr = null;
  let curKey = null;
  let afterColon = false;
  let elemStart = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    s += value;
    re.lastIndex = scanned;
    scanned = s.length;
    let m;
    while ((m = re.exec(s))) {
      const c = m[0];
      const p = m.index;
      if (c === '"') {
        let q = p + 1;
        for (;;) {
          q = s.indexOf('"', q);
          if (q < 0) break;
          let b = 0;
          while (s[q - 1 - b] === '\\') b++;
          if (b % 2 === 0) break;
          q++;
        }
        if (q < 0) { scanned = p; break; } // string cortada no meio: espera o próximo pedaço
        re.lastIndex = q + 1;
        if (depth === 1) {
          if (afterColon) { yield { key: curKey, value: JSON.parse(s.slice(p, q + 1)) }; afterColon = false; }
          else lastStr = s.slice(p + 1, q);
        }
      } else if (c === ',') {
        if (depth === 1) afterColon = false;
      } else if (c === ':') {
        if (depth === 1) { curKey = lastStr; afterColon = true; }
      } else if (c === '{' || c === '[') {
        if (c === '{' && depth === 2) elemStart = p;
        depth++;
        afterColon = false;
      } else {
        depth--;
        if (c === '}' && depth === 2 && elemStart >= 0) {
          const text = s.slice(elemStart, p + 1);
          elemStart = -1;
          yield { key: curKey, value: JSON.parse(text) };
        } else if (c === ']' && depth === 1) curKey = null;
      }
    }
    // descarta o que já foi processado, guardando só o elemento em andamento
    const cut = elemStart >= 0 ? elemStart : scanned;
    s = s.slice(cut);
    scanned -= cut;
    if (elemStart >= 0) elemStart = 0;
  }
}

// Mescla o backup com o que já existe (mesmo id = substitui).
export async function importBackup(file, onProgress) {
  let isBackup = false;
  let songs = 0;
  let setlists = 0;
  let pages = 0;
  for await (const { key, value } of scanBackup(file)) {
    if (key === 'app') {
      if (value !== 'repertorio') break;
      isBackup = true;
    } else if (!isBackup) {
      break;
    } else if (key === 'songs') {
      await db.put('songs', value);
      songs++;
    } else if (key === 'pages') {
      await db.putDurable('pages', { id: value.id, songId: value.songId, n: value.n, blob: await dataURLToBlob(value.data) });
      pages++;
      if (onProgress && pages % 5 === 0) onProgress(pages);
    } else if (key === 'setlists') {
      await db.put('setlists', value);
      setlists++;
    }
  }
  if (!isBackup) throw new Error('Esse arquivo não é um backup do Repertório.');
  return { songs, pages, setlists };
}
