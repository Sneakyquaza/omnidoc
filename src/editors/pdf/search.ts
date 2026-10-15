/** Occurrence dans les éléments de texte d'une page (index d'élément + décalage dans sa chaîne). */
export interface TextMatch {
  startItem: number;
  startOffset: number;
  endItem: number;
  /** Exclusif. */
  endOffset: number;
}

/** Cherche `query` (sans casse) dans la concaténation des éléments de texte d'une page. */
export function findMatches(items: string[], query: string): TextMatch[] {
  const needle = query.toLowerCase();
  if (needle === "" || items.length === 0) return [];
  const starts: number[] = [];
  let total = 0;
  for (const s of items) {
    starts.push(total);
    total += s.length;
  }
  const hay = items.join("").toLowerCase();
  // Élément contenant le caractère `key` (dernier élément dont le début est <= key).
  const locate = (key: number): number => {
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= key) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const out: TextMatch[] = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    const end = i + needle.length;
    const startItem = locate(i);
    const endItem = locate(end - 1);
    out.push({
      startItem,
      startOffset: i - starts[startItem]!,
      endItem,
      endOffset: end - starts[endItem]!,
    });
    from = end;
  }
  return out;
}
