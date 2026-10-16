import type { Cell, CellValue, CsvOptions, Sheet, Workbook } from "../../ipc/bindings";
import { ERR, errFromCode, isErr } from "./formula/values";
import type { Scalar } from "./formula/values";

export const EMPTY_VALUE: CellValue = { type: "empty" };
export const EMPTY_CELL: Cell = { v: EMPTY_VALUE, f: null, fmt: null };

/** Largeur d'un caractère Excel en pixels et largeur par défaut d'une colonne. */
export const CHAR_PX = 7;
export const DEFAULT_COL_PX = 80;
export const MIN_COL_PX = 24;

export function isEmptyCell(c: Cell | undefined): boolean {
  return !c || (c.v.type === "empty" && !c.f && !c.fmt);
}

export function cellToScalar(v: CellValue): Scalar {
  switch (v.type) {
    case "empty":
      return null;
    case "number":
      return v.value === null ? ERR.NUM : v.value;
    case "text":
      return v.value;
    case "bool":
      return v.value;
    case "error":
      return errFromCode(v.value);
  }
}

export function scalarToCellValue(s: Scalar): CellValue {
  if (s === null) return EMPTY_VALUE;
  if (isErr(s)) return { type: "error", value: s.err };
  if (typeof s === "number") {
    return Number.isFinite(s) ? { type: "number", value: s } : { type: "error", value: "#NUM!" };
  }
  if (typeof s === "boolean") return { type: "bool", value: s };
  return { type: "text", value: s };
}

/** Étendue réellement utilisée (nombre de lignes / colonnes jusqu'à la dernière cellule non vide). */
export function usedExtent(rows: Cell[][]): { rows: number; cols: number } {
  let nRows = 0;
  let nCols = 0;
  for (let r = rows.length - 1; r >= 0; r--) {
    const row = rows[r] as Cell[];
    let last = row.length - 1;
    while (last >= 0 && isEmptyCell(row[last])) last--;
    if (last >= 0) {
      if (nRows === 0) nRows = r + 1;
      nCols = Math.max(nCols, last + 1);
    }
  }
  return { rows: nRows, cols: nCols };
}

/** Cellule telle que reçue du backend : nue (sans formule ni format) ou objet complet. */
type WireCell = null | number | string | boolean | Cell;

function decodeCell(w: WireCell): Cell {
  switch (typeof w) {
    case "number":
      return { v: { type: "number", value: w }, f: null, fmt: null };
    case "string":
      return { v: { type: "text", value: w }, f: null, fmt: null };
    case "boolean":
      return { v: { type: "bool", value: w }, f: null, fmt: null };
    default:
      return w === null ? EMPTY_CELL : { ...w, f: w.f ?? null, fmt: w.fmt ?? null };
  }
}

/** Feuilles du modèle reçu du backend (cellules nues, voir `Cell` côté Rust) → cellules objets. */
export function decodeSheets(sheets: Sheet[]): Sheet[] {
  return sheets.map((s) => ({
    ...s,
    rows: (s.rows as unknown as WireCell[][]).map((r) => r.map(decodeCell)),
    colWidths: s.colWidths ? s.colWidths.slice() : null,
  }));
}

/** Copie profonde légère (les cellules sont immuables). */
export function cloneSheets(sheets: Sheet[]): Sheet[] {
  return sheets.map((s) => ({
    ...s,
    rows: s.rows.map((r) => r.slice()),
    colWidths: s.colWidths ? s.colWidths.slice() : null,
  }));
}

/** Modèle sérialisable : valeurs recalculées, lignes/cellules vides de fin retirées. */
export function buildWorkbook(
  sheets: Sheet[],
  csv: CsvOptions | null,
  lossy: string[] | undefined,
): Workbook {
  const out: Sheet[] = sheets.map((s) => {
    const rows = s.rows.map((r) => r.slice());
    for (const row of rows) {
      while (row.length > 0 && isEmptyCell(row[row.length - 1])) row.pop();
      // « #CYCLE! » n'existe pas dans les formats de fichier
      row.forEach((c, i) => {
        if (c.v.type === "error" && c.v.value === ERR.CYCLE.err) {
          row[i] = { ...c, v: { type: "error", value: ERR.REF.err } };
        }
      });
    }
    while (rows.length > 0 && (rows[rows.length - 1] as Cell[]).length === 0) rows.pop();
    let colWidths = s.colWidths;
    if (colWidths && colWidths.every((w) => !w)) colWidths = null;
    return { name: s.name, rows, colWidths: colWidths ? colWidths.slice() : null };
  });
  const wb: Workbook = { sheets: out, csv };
  if (lossy) wb.lossy = lossy;
  return wb;
}
