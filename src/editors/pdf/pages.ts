/**
 * Nouvel ordre des pages (permutation complète, pages 1-based) après déplacement du bloc `selected`
 * juste avant la page d'origine `insertBefore` (1..pageCount + 1).
 */
export function reorderPages(
  pageCount: number,
  selected: number[],
  insertBefore: number,
): number[] {
  const moving = [...new Set(selected)]
    .filter((p) => p >= 1 && p <= pageCount)
    .sort((a, b) => a - b);
  const movingSet = new Set(moving);
  const head: number[] = [];
  const tail: number[] = [];
  for (let p = 1; p <= pageCount; p++) {
    if (movingSet.has(p)) continue;
    (p < insertBefore ? head : tail).push(p);
  }
  return [...head, ...moving, ...tail];
}

export function isIdentity(order: number[]): boolean {
  return order.every((p, i) => p === i + 1);
}

/** Sélection de miniatures : clic simple, Ctrl (bascule) ou Shift (plage depuis l'ancre). */
export function nextSelection(
  current: number[],
  anchor: number,
  page: number,
  mods: { ctrl: boolean; shift: boolean },
): number[] {
  if (mods.shift) {
    const [a, b] = anchor <= page ? [anchor, page] : [page, anchor];
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  if (mods.ctrl) {
    return current.includes(page)
      ? current.filter((p) => p !== page)
      : [...current, page].sort((x, y) => x - y);
  }
  return [page];
}
