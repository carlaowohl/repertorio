// Importação de imagens: lê o nome do arquivo, reduz a imagem e salva.
//
// Padrões aceitos:
//   "Banda - Nome da Música 2.jpg"      -> banda, título, página 2
//   "Nome da Música 1.jpg"              -> sem banda (ou nome da pasta, se veio de pasta)
//   "Banda/Nome da Música.jpg"          -> banda pela pasta, página 1
import * as db from './db.js';
import { NO_BAND, fold, bandNames } from './names.js';

const MAX_SIDE = 2400; // px — legível no tablet e bem mais leve que foto original
const JPEG_QUALITY = 0.85;
export { NO_BAND };

export function parseFileName(file) {
  const base = file.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const folder = (file.webkitRelativePath || '').split('/').slice(-2, -1)[0] || '';

  let band = '';
  let rest = base;
  // Separador banda/título: " - ", e também "Banda- Título", "Banda -Título" e travessões (– —).
  // Hífen colado dos dois lados ("Jota-Quest") não separa.
  const sepMatch = /\s+[-–—]\s*|\s*[-–—]\s+/.exec(base);
  const afterSep = sepMatch ? base.slice(sepMatch.index + sepMatch[0].length).trim() : '';
  const bothSides = sepMatch && /^\s/.test(sepMatch[0]) && /\s$/.test(sepMatch[0]);
  // Com espaço só de um lado, exige letras depois ("Música -2" é página, não banda).
  if (sepMatch && sepMatch.index > 0 && (bothSides || /[A-Za-zÀ-ÿ]/.test(afterSep))) {
    band = base.slice(0, sepMatch.index).trim();
    rest = afterSep;
  } else if (folder) {
    band = folder.trim();
  }

  // Número no final separado por espaço (até 2 dígitos) = página.
  let page = 1;
  const m = rest.match(/^(.*\S)\s+(\d{1,2})$/);
  if (m) {
    rest = m[1].trim();
    page = parseInt(m[2], 10);
  }

  return { band: band || NO_BAND, title: rest || base, page };
}

async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.type === 'image/jpeg') {
      bmp.close();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // PNG transparente vira fundo branco
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
  } catch {
    return file; // se o navegador não conseguir processar, guarda o original
  }
}

export async function importFiles(fileList, onProgress = () => {}) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  const touched = new Map(); // songId -> song
  let done = 0;

  // Arquivo sem banda cuja música já existe com banda (ex: completada antes) vai para ela.
  const existing = await db.getAll('songs');
  const bandFor = (title) => {
    const t = db.songKey('', title);
    const hits = existing.filter((s) => s.band !== NO_BAND && db.songKey('', s.title) === t);
    return hits.length === 1 ? hits[0].band : NO_BAND;
  };
  // Banda já cadastrada com outra grafia ("legião urbana" x "Legião Urbana") usa a que já existe.
  const names = bandNames(existing);

  for (const file of files) {
    const parsed = parseFileName(file);
    const { title, page } = parsed;
    let band = parsed.band === NO_BAND ? bandFor(title) : parsed.band;
    const known = names.get(fold(band));
    if (known) band = known;
    else names.set(fold(band), band);
    const key = db.songKey(band, title);
    let song = touched.get(key) || (await db.findSongByKey(key));
    if (!song) {
      song = { id: db.uid(), band, title, key, pageCount: 0, createdAt: Date.now() };
    }
    const blob = await shrink(file);
    await db.putPage(song.id, page, blob);
    song.pageCount = Math.max(song.pageCount, page);
    song.updatedAt = Date.now();
    touched.set(key, song);
    await db.put('songs', song);
    onProgress(++done, files.length);
  }

  // Recalcula a contagem real de páginas (caso falte alguma no meio).
  for (const song of touched.values()) {
    song.pageCount = (await db.getPages(song.id)).length;
    await db.put('songs', song);
  }

  return { files: files.length, songs: touched.size, skipped: fileList.length - files.length };
}
