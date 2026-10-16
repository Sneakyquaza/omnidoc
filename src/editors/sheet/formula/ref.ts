/** Utilitaires de références A1. */

export const MAX_COLS = 16384;
export const MAX_ROWS = 1048576;

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function colToName(col: number): string {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "A" → 0, "AA" → 26 ; -1 si invalide. */
export function nameToCol(name: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(name)) return -1;
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function cellName(row: number, col: number, absRow = false, absCol = false): string {
  return `${absCol ? "$" : ""}${colToName(col)}${absRow ? "$" : ""}${row + 1}`;
}

export interface ParsedRef {
  row: number;
  col: number;
  absRow: boolean;
  absCol: boolean;
}

const REF_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;

/** "$B$3" → {row:2, col:1, …} ; null si ce n'est pas une référence valide. */
export function parseCellRef(text: string): ParsedRef | null {
  const m = REF_RE.exec(text);
  if (!m) return null;
  const col = nameToCol(m[2] ?? "");
  const row = Number(m[4]) - 1;
  if (col < 0 || col >= MAX_COLS || row < 0 || row >= MAX_ROWS) return null;
  return { row, col, absRow: m[3] === "$", absCol: m[1] === "$" };
}

export interface RangeBox {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** Ordonne les coins d'une plage. */
export function normalizeRange(a: RangeBox): RangeBox {
  return {
    r1: Math.min(a.r1, a.r2),
    c1: Math.min(a.c1, a.c2),
    r2: Math.max(a.r1, a.r2),
    c2: Math.max(a.c1, a.c2),
  };
}

/** "A1:B5" ou "A1" → plage ; null si invalide. */
export function parseRangeText(text: string): RangeBox | null {
  const parts = text.trim().split(":");
  if (parts.length > 2) return null;
  const a = parseCellRef(parts[0] ?? "");
  const b = parts.length === 2 ? parseCellRef(parts[1] ?? "") : a;
  if (!a || !b) return null;
  return normalizeRange({ r1: a.row, c1: a.col, r2: b.row, c2: b.col });
}

export function rangeName(box: RangeBox): string {
  const a = cellName(box.r1, box.c1);
  return box.r1 === box.r2 && box.c1 === box.c2 ? a : `${a}:${cellName(box.r2, box.c2)}`;
}
