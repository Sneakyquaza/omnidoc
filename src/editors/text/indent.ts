export interface IndentInfo {
  /** `tab` ou nombre d'espaces par niveau. */
  unit: "tab" | number;
}

/** Détecte l'indentation dominante (tabulations ou espaces) sur le début du texte. */
export function detectIndent(text: string, fallback = 2): IndentInfo {
  let tabs = 0;
  const diffs = new Map<number, number>();
  let prevSpaces = 0;
  let seen = 0;
  for (const line of text.slice(0, 200_000).split("\n")) {
    if (seen > 2000) break;
    if (line.trim() === "") continue;
    seen++;
    if (line.startsWith("\t")) {
      tabs++;
      prevSpaces = 0;
      continue;
    }
    const spaces = (/^ */.exec(line) as RegExpExecArray)[0].length;
    const d = Math.abs(spaces - prevSpaces);
    if (spaces > 0 && d > 0 && d <= 8) diffs.set(d, (diffs.get(d) ?? 0) + 1);
    prevSpaces = spaces;
  }
  let best = fallback;
  let bestCount = 0;
  for (const [d, n] of diffs) {
    if (n > bestCount || (n === bestCount && d < best)) {
      best = d;
      bestCount = n;
    }
  }
  if (tabs > bestCount) return { unit: "tab" };
  return { unit: best };
}
