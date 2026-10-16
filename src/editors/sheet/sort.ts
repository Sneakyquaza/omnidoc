import type { Cell } from "../../ipc/bindings";
import type { CellChange } from "./formula/engine";
import { offsetFormula } from "./formula/rewrite";
import type { RangeBox } from "./formula/ref";
import { compareValues, isErr } from "./formula/values";
import { EMPTY_CELL, cellToScalar } from "./model";

/** Tri des lignes d'une plage selon une colonne ; renvoie les cellules à modifier. */
export function sortChanges(
  rows: Cell[][],
  sheet: number,
  box: RangeBox,
  keyCol: number,
  ascending: boolean,
  header: boolean,
): CellChange[] {
  const start = box.r1 + (header ? 1 : 0);
  if (start >= box.r2) return [];
  const indexes: number[] = [];
  for (let r = start; r <= box.r2; r++) indexes.push(r);
  const keyOf = (r: number) => cellToScalar(rows[r]?.[keyCol]?.v ?? { type: "empty" });
  const rankOf = (r: number): number => {
    const k = keyOf(r);
    if (k === null || k === "") return 4;
    if (isErr(k)) return 3;
    if (typeof k === "number") return 0;
    if (typeof k === "string") return 1;
    return 2;
  };
  const sorted = indexes
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ra = rankOf(a.r);
      const rb = rankOf(b.r);
      if (ra === 4 || rb === 4) return ra === rb ? a.i - b.i : ra === 4 ? 1 : -1;
      if (ra !== rb) return ascending ? ra - rb : rb - ra;
      const c = compareValues(keyOf(a.r), keyOf(b.r));
      return c !== 0 ? (ascending ? c : -c) : a.i - b.i;
    })
    .map((x) => x.r);

  const changes: CellChange[] = [];
  sorted.forEach((from, offset) => {
    const to = start + offset;
    if (from === to) return;
    for (let c = box.c1; c <= box.c2; c++) {
      const src = rows[from]?.[c] ?? EMPTY_CELL;
      const cell = src.f ? { ...src, f: offsetFormula(src.f, to - from, 0) } : src;
      changes.push({ sheet, row: to, col: c, cell });
    }
  });
  return changes;
}
