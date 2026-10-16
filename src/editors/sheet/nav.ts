export interface Pos {
  r: number;
  c: number;
}

/**
 * Déplacement Ctrl+flèche : saute au bout du bloc de cellules remplies, ou à la prochaine
 * cellule remplie après un vide ; sinon au bord de la grille.
 */
export function ctrlArrow(
  filled: (r: number, c: number) => boolean,
  pos: Pos,
  dr: number,
  dc: number,
  rows: number,
  cols: number,
): Pos {
  const inside = (r: number, c: number) => r >= 0 && c >= 0 && r < rows && c < cols;
  let r = pos.r + dr;
  let c = pos.c + dc;
  if (!inside(r, c)) return pos;
  if (filled(pos.r, pos.c) && filled(r, c)) {
    while (inside(r + dr, c + dc) && filled(r + dr, c + dc)) {
      r += dr;
      c += dc;
    }
    return { r, c };
  }
  while (inside(r, c) && !filled(r, c)) {
    r += dr;
    c += dc;
  }
  if (inside(r, c)) return { r, c };
  return { r: Math.max(0, Math.min(rows - 1, r - dr)), c: Math.max(0, Math.min(cols - 1, c - dc)) };
}

/** Ligne voisine visible (`order` = lignes visibles triées, null = toutes). */
export function stepRow(order: number[] | null, r: number, dir: 1 | -1): number {
  if (!order) return Math.max(0, r + dir);
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((order[mid] as number) < r) lo = mid + 1;
    else hi = mid;
  }
  const idx = lo + dir;
  if (idx < 0) return order[0] ?? 0;
  if (idx >= order.length) return r + dir;
  return order[idx] as number;
}
