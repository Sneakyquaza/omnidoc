import type { Sheet } from "../../ipc/bindings";
import {
  adjustForStructure,
  removeSheetFromFormula,
  renameSheetInFormula,
} from "./formula/rewrite";
import type { Axis } from "./formula/rewrite";
import { EMPTY_CELL, cloneSheets } from "./model";

/** Opérations structurelles sur les feuilles (renvoient de nouvelles feuilles, formules adaptées). */

function mapFormulas(sheets: Sheet[], fn: (f: string, sheetName: string) => string): Sheet[] {
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      row.forEach((cell, i) => {
        if (cell.f) {
          const f = fn(cell.f, sheet.name);
          if (f !== cell.f) row[i] = { ...cell, f };
        }
      });
    }
  }
  return sheets;
}

export function insertAxis(
  sheets: Sheet[],
  si: number,
  axis: Axis,
  index: number,
  count: number,
): Sheet[] {
  const out = cloneSheets(sheets);
  const sheet = out[si];
  if (!sheet) return out;
  if (axis === "row") {
    while (sheet.rows.length < index) sheet.rows.push([]);
    sheet.rows.splice(
      index,
      0,
      ...Array.from({ length: count }, () => [] as (typeof sheet.rows)[number]),
    );
  } else {
    for (const row of sheet.rows) {
      if (row.length > index)
        row.splice(index, 0, ...Array.from({ length: count }, () => EMPTY_CELL));
    }
    if (sheet.colWidths) {
      while (sheet.colWidths.length < index) sheet.colWidths.push(null);
      sheet.colWidths.splice(index, 0, ...Array.from({ length: count }, () => null));
    }
  }
  return mapFormulas(out, (f, name) => adjustForStructure(f, name, sheet.name, axis, index, count));
}

export function deleteAxis(
  sheets: Sheet[],
  si: number,
  axis: Axis,
  index: number,
  count: number,
): Sheet[] {
  const out = cloneSheets(sheets);
  const sheet = out[si];
  if (!sheet) return out;
  if (axis === "row") sheet.rows.splice(index, count);
  else {
    for (const row of sheet.rows) row.splice(index, count);
    sheet.colWidths?.splice(index, count);
  }
  return mapFormulas(out, (f, name) =>
    adjustForStructure(f, name, sheet.name, axis, index, -count),
  );
}

export function uniqueSheetName(sheets: Sheet[], base: string, ignore = -1): string {
  const taken = new Set(sheets.filter((_s, i) => i !== ignore).map((s) => s.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export function addSheet(sheets: Sheet[], name: string): Sheet[] {
  return [...cloneSheets(sheets), { name, rows: [], colWidths: null }];
}

export function renameSheet(sheets: Sheet[], si: number, name: string): Sheet[] {
  const out = cloneSheets(sheets);
  const sheet = out[si];
  if (!sheet) return out;
  const old = sheet.name;
  sheet.name = name;
  return mapFormulas(out, (f) => renameSheetInFormula(f, old, name));
}

export function deleteSheet(sheets: Sheet[], si: number): Sheet[] {
  const out = cloneSheets(sheets);
  const [removed] = out.splice(si, 1);
  if (!removed) return out;
  return mapFormulas(out, (f) => removeSheetFromFormula(f, removed.name));
}

export function moveSheet(sheets: Sheet[], from: number, to: number): Sheet[] {
  const out = cloneSheets(sheets);
  const [s] = out.splice(from, 1);
  if (s) out.splice(to, 0, s);
  return out;
}
