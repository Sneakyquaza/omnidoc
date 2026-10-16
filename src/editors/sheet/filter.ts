import type { Cell } from "../../ipc/bindings";

/** Filtre automatique : masquage visuel de lignes, jamais sérialisé. */
export interface FilterState {
  enabled: boolean;
  /** Colonne → valeurs affichées décochées. */
  excluded: Record<number, string[]>;
}

export const NO_FILTER: FilterState = { enabled: false, excluded: {} };

/** Valeurs affichées distinctes d'une colonne (ligne d'en-tête 0 exclue), triées. */
export function uniqueValues(
  rows: Cell[][],
  col: number,
  display: (cell: Cell | undefined) => string,
): string[] {
  const set = new Set<string>();
  for (let r = 1; r < rows.length; r++) set.add(display(rows[r]?.[col]));
  return Array.from(set).sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  });
}

export function isFiltered(filter: FilterState, col: number): boolean {
  return (filter.excluded[col]?.length ?? 0) > 0;
}

/**
 * Indices de lignes visibles parmi `total` ; null si aucun filtre actif.
 * La ligne 0 (en-tête) et les lignes au-delà des données restent visibles.
 */
export function visibleRows(
  rows: Cell[][],
  total: number,
  filter: FilterState,
  display: (cell: Cell | undefined) => string,
): number[] | null {
  const active = Object.entries(filter.excluded).filter(([, v]) => v.length > 0);
  if (!filter.enabled || active.length === 0) return null;
  const sets = active.map(([c, v]) => [Number(c), new Set(v)] as const);
  const out: number[] = [];
  for (let r = 0; r < total; r++) {
    let hidden = false;
    if (r > 0 && r < rows.length) {
      for (const [c, set] of sets) {
        if (set.has(display(rows[r]?.[c]))) {
          hidden = true;
          break;
        }
      }
    }
    if (!hidden) out.push(r);
  }
  return out;
}
