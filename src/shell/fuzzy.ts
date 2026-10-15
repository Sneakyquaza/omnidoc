/** Minuscules sans diacritiques. */
export function normalize(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Score d'une recherche floue (sous-séquence) ; `null` si aucun appariement. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = normalize(query).replace(/\s+/g, "");
  if (q === "") return 0;
  const t = normalize(text);
  let from = 0;
  let previous = -2;
  let score = 0;
  for (const ch of q) {
    const index = t.indexOf(ch, from);
    if (index < 0) return null;
    score += 1;
    if (index === previous + 1) score += 3;
    if (index === 0 || /[\s\-_/.:]/.test(t.charAt(index - 1))) score += 2;
    score -= (index - from) * 0.05;
    previous = index;
    from = index + 1;
  }
  if (t.includes(q)) score += 5;
  return score;
}

/** Filtre et trie (meilleur score d'abord, ordre d'origine à égalité). */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, getText(item)) }))
    .filter((r): r is { item: T; index: number; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.item);
}
