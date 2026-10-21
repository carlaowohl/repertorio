// Sugere o artista de uma música pelo título, usando a base pública do MusicBrainz.
// Não pega o primeiro resultado (costuma ser uma regravação qualquer): soma quantas
// gravações cada artista tem com aquele título e quantos lançamentos cada uma teve.
// Precisa de internet. O MusicBrainz pede no máximo 1 consulta por segundo.

const API = 'https://musicbrainz.org/ws/2/recording';
const MIN_GAP_MS = 1100;
let lastCall = 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export async function suggestArtists(title, knownBands = []) {
  const gap = lastCall + MIN_GAP_MS - Date.now();
  if (gap > 0) await wait(gap);
  lastCall = Date.now();

  const q = `recording:"${title.replace(/"/g, '')}"`;
  const res = await fetch(`${API}?query=${encodeURIComponent(q)}&fmt=json&limit=100`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 503) { await wait(2000); return suggestArtists(title, knownBands); }
  if (!res.ok) throw new Error(`Busca falhou (${res.status})`);
  const data = await res.json();

  const want = fold(title);
  const known = new Map(knownBands.map((b) => [fold(b), b]));
  const totals = new Map();
  for (const rec of data.recordings || []) {
    if (rec.score < 90 || fold(rec.title) !== want) continue;
    const name = (rec['artist-credit'] || []).map((c) => c.name + (c.joinphrase || '')).join('').trim();
    if (!name || /^various artists$/i.test(name)) continue;
    const weight = 1 + Math.min(5, (rec.releases || []).length) * 0.2;
    totals.set(name, (totals.get(name) || 0) + weight);
  }

  return [...totals.entries()]
    .map(([name, score]) => {
      const mine = known.get(fold(name));
      // Banda que já está na biblioteca tem mais chance de ser a certa.
      return { name: mine || name, score: mine ? score * 1.6 + 3 : score, known: !!mine };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
