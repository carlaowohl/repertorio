// Comparação de nomes de banda e de música sem ligar para maiúsculas, acentos e espaços repetidos.
// Sem dependências: pode ser usado por qualquer módulo.

export const NO_BAND = 'Sem banda';

// "Legião  Urbana" e "legiao urbana" dão o mesmo resultado.
export const fold = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Só letras e números: ignora também a pontuação ("Ao Vivo." = "ao vivo").
export const loose = (s) => fold(s).replace(/[^a-z0-9]+/g, ' ').trim();

const allLower = (s) => s === s.toLowerCase() && s !== s.toUpperCase();

// Entre as grafias da mesma banda ("legião urbana", "Legião Urbana"), escolhe a que vale para todas:
// evita a toda em minúsculas, depois a mais usada, depois a ordem alfabética.
export function pickName(names) {
  const count = new Map();
  names.forEach((n) => count.set(n, (count.get(n) || 0) + 1));
  return [...count.entries()].sort(
    (a, b) => allLower(a[0]) - allLower(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR')
  )[0][0];
}

// Mapa: chave da banda (fold) -> nome que deve aparecer.
export function bandNames(songs) {
  const groups = new Map();
  for (const s of songs) {
    const k = fold(s.band);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s.band);
  }
  return new Map([...groups].map(([k, list]) => [k, k === fold(NO_BAND) ? NO_BAND : pickName(list)]));
}
