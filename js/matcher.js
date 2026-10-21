// Transforma um texto colado (ex: mensagem do grupo) em sequência de músicas da biblioteca.
//
// Cada linha vira uma entrada:
//   { line, query, status: 'ok' | 'choose' | 'guess' | 'none', songId, candidates: [{ song, score }] }
// ok     = bateu exatamente com uma música
// choose = bateu exatamente com mais de uma (mesmo título, bandas diferentes)
// guess  = não bateu exato; songId é a sugestão mais parecida
// none   = nada parecido o suficiente

const MIN_SCORE = 0.5;

export const normalize = (s) =>
  s.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Limpa o que o WhatsApp e as listas costumam ter em volta do nome.
export function cleanLine(line) {
  return line
    .replace(/[*_~`]/g, '')                                   // negrito/itálico do WhatsApp
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '') // emojis
    .replace(/^\s*(?:\d{1,3}\s*[.)\-–—:º°]+|[-–—•·>]+)\s*/, '') // "1." "01 -" "2)" "•"
    .replace(/\s*[([].*?[)\]]\s*$/, '')                       // "(tom G)" no final
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const ratio = (a, b) => 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

// Quanto das palavras digitadas aparece (com tolerância a erro) no alvo.
function tokenCoverage(q, target) {
  const qt = q.split(' ').filter((t) => t.length > 1);
  const tt = target.split(' ');
  if (!qt.length) return 0;
  const hits = qt.filter((w) => tt.some((t) => t === w || (w.length > 3 && ratio(w, t) >= 0.75)));
  return hits.length / qt.length;
}

function score(q, song) {
  const title = normalize(song.title);
  const full = normalize(`${song.band} ${song.title}`);
  const cover = Math.max(tokenCoverage(q, title), tokenCoverage(q, full));
  // Tudo que foi digitado está no título, mas o título tem palavras a mais: bom, não perfeito.
  const coverScore = cover === 1 ? 0.85 : cover * 0.7;
  return Math.max(ratio(q, title), ratio(q, full), coverScore);
}

function exactMatches(q, songs) {
  return songs.filter((s) => normalize(s.title) === q || normalize(`${s.band} ${s.title}`) === q);
}

function resolve(text, songs) {
  const q = normalize(text);
  if (!q) return null;
  const exact = exactMatches(q, songs);
  if (exact.length) return { q, exact };
  // "Banda - Música": tenta também só a parte da música, preferindo a banda citada.
  const sep = text.indexOf(' - ');
  if (sep > 0) {
    const band = normalize(text.slice(0, sep));
    const title = normalize(text.slice(sep + 3));
    const byTitle = songs.filter((s) => normalize(s.title) === title);
    const sameBand = byTitle.filter((s) => ratio(normalize(s.band), band) >= 0.8);
    if (sameBand.length) return { q, exact: sameBand };
  }
  return { q, exact: [] };
}

export function matchList(text, songs) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = cleanLine(raw);
    if (!line) continue;

    // 1º tenta a linha inteira (títulos que terminam em número, tipo "Música 2").
    // Se não bater, tira o número final: "Música X 2" = página 2 da Música X.
    let r = resolve(line, songs);
    let query = line;
    const pageless = line.replace(/\s+\d{1,2}$/, '');
    if (!r?.exact.length && pageless !== line) {
      r = resolve(pageless, songs);
      query = pageless;
    }
    if (!r) continue;

    const ranked = songs
      .map((song) => ({ song, score: score(r.q, song) }))
      .sort((a, b) => b.score - a.score);

    let entry;
    if (r.exact.length === 1) {
      entry = { status: 'ok', songId: r.exact[0].id, candidates: [{ song: r.exact[0], score: 1 }] };
    } else if (r.exact.length > 1) {
      entry = { status: 'choose', songId: r.exact[0].id, candidates: r.exact.map((song) => ({ song, score: 1 })) };
    } else if (ranked[0] && ranked[0].score >= MIN_SCORE) {
      entry = { status: 'guess', songId: ranked[0].song.id, candidates: ranked.filter((c) => c.score >= 0.35).slice(0, 5) };
    } else {
      entry = { status: 'none', songId: null, candidates: ranked.filter((c) => c.score >= 0.3).slice(0, 5) };
    }
    entries.push({ line: raw.trim(), query, ...entry });
  }
  return entries;
}

// Remove repetições seguidas da mesma música ("Música X 1", "Música X 2" -> uma entrada só).
// Só junta quando é o mesmo nome escrito de novo; músicas diferentes que caíram na mesma sugestão ficam.
export function collapse(entries) {
  return entries.filter((e, i) => {
    const prev = entries[i - 1];
    return !(e.songId && prev && prev.songId === e.songId && normalize(prev.query) === normalize(e.query));
  });
}

// A primeira linha é título do repertório quando não parece música nenhuma.
export function splitTitle(text, songs) {
  const lines = text.split(/\r?\n/).filter((l) => cleanLine(l));
  if (lines.length < 2) return { name: '', body: text };
  const numbered = (l) => /^\s*[*_]*\d{1,3}\s*[.)\-–—:º°]/.test(l);
  const looksLikeHeader = !numbered(lines[0]) && lines.slice(1).filter(numbered).length >= (lines.length - 1) / 2;
  const [first] = matchList(lines[0], songs);
  if (looksLikeHeader || (first && first.status === 'none')) {
    return { name: cleanLine(lines[0]), body: lines.slice(1).join('\n') };
  }
  return { name: '', body: text };
}
