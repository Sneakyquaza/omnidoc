import { describe, expect, it } from "vitest";
import type { Cell, Sheet } from "../../ipc/bindings";
import { Engine } from "./formula/engine";
import { offsetFormula, adjustForStructure, renameSheetInFormula } from "./formula/rewrite";
import { cellName, colToName, nameToCol, parseRangeText } from "./formula/ref";
import { visibleRows, uniqueValues } from "./filter";
import { History } from "./history";
import { cellInputText, parseCellInput } from "./input";
import { buildWorkbook, decodeSheets, EMPTY_CELL, usedExtent } from "./model";
import { ctrlArrow } from "./nav";
import { changeDecimals, dateToSerial, formatCell, formatNumber, isDateFormat } from "./numfmt";
import { sortChanges } from "./sort";
import {
  addSheet,
  deleteAxis,
  deleteSheet,
  insertAxis,
  moveSheet,
  renameSheet,
  uniqueSheetName,
} from "./structure";
import { parseTsv, serializeTsv } from "./tsv";

const num = (n: number, fmt: string | null = null): Cell => ({
  v: { type: "number", value: n },
  f: null,
  fmt,
});
const txt = (s: string): Cell => ({ v: { type: "text", value: s }, f: null, fmt: null });
const fx = (f: string): Cell => ({ v: { type: "empty" }, f, fmt: null });
const sheetOf = (name: string, rows: Cell[][]): Sheet => ({ name, rows, colWidths: null });

describe("références", () => {
  it("noms de colonnes", () => {
    expect(colToName(0)).toBe("A");
    expect(colToName(25)).toBe("Z");
    expect(colToName(26)).toBe("AA");
    expect(colToName(701)).toBe("ZZ");
    expect(nameToCol("AA")).toBe(26);
    expect(cellName(2, 1)).toBe("B3");
    expect(parseRangeText("B2:A1")).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(parseRangeText("zz")).toBeNull();
  });
});

describe("formats de nombre", () => {
  it("nombres de base", () => {
    expect(formatNumber(1234.5, "0", "en")).toBe("1235");
    expect(formatNumber(1234.5, "0.00", "en")).toBe("1234.50");
    expect(formatNumber(1234567.891, "#,##0", "en")).toBe("1,234,568");
    expect(formatNumber(1234567.891, "#,##0.00", "en")).toBe("1,234,567.89");
    expect(formatNumber(0.256, "0%", "en")).toBe("26%");
    expect(formatNumber(0.256, "0.00%", "en")).toBe("25.60%");
    expect(formatNumber(-5, "0.0", "en")).toBe("-5.0");
    expect(formatNumber(0.5, "#.00", "en")).toBe(".50");
    expect(formatNumber(5, "000", "en")).toBe("005");
  });

  it("locale française", () => {
    expect(formatNumber(1234.5, "#,##0.00", "fr")).toBe("1 234,50");
    expect(formatNumber(0.5, "General", "fr")).toBe("0,5");
  });

  it("monétaire et littéraux", () => {
    expect(formatNumber(12.5, '#,##0.00 "€"', "en")).toBe("12.50 €");
    expect(formatNumber(-12.5, '#,##0.00 "€"', "en")).toBe("-12.50 €");
    expect(formatNumber(3, '0" kg"', "en")).toBe("3 kg");
    expect(formatNumber(5, "#,##0.00;[Red]-#,##0.00", "en")).toBe("5.00");
    expect(formatNumber(-5, "#,##0.00;(#,##0.00)", "en")).toBe("(5.00)");
  });

  it("général", () => {
    expect(formatNumber(42, null, "en")).toBe("42");
    expect(formatNumber(1 / 3, null, "en")).toBe("0.3333333333");
    expect(formatNumber(1e12, "General", "en")).toMatch(/E\+12$/);
  });

  it("dates et heures", () => {
    const d = dateToSerial(2024, 3, 5, 14, 7, 9);
    expect(formatNumber(d, "yyyy-mm-dd", "en")).toBe("2024-03-05");
    expect(formatNumber(d, "dd/mm/yyyy", "en")).toBe("05/03/2024");
    expect(formatNumber(d, "yyyy-mm-dd hh:mm:ss", "en")).toBe("2024-03-05 14:07:09");
    expect(formatNumber(d, "hh:mm", "en")).toBe("14:07");
    expect(formatNumber(d, "h:mm AM/PM", "en")).toBe("2:07 PM");
    expect(formatNumber(d, "d mmmm yyyy", "fr")).toBe("5 mars 2024");
    expect(formatNumber(d, "ddd d mmm", "en")).toBe("Tue 5 Mar");
    expect(formatNumber(1.5, "[h]:mm:ss", "en")).toBe("36:00:00");
    expect(formatNumber(3.75, "[h]:mm", "en")).toBe("90:00");
  });

  it("détection", () => {
    expect(isDateFormat("yyyy-mm-dd")).toBe(true);
    expect(isDateFormat("0.00")).toBe(false);
    expect(isDateFormat(null)).toBe(false);
    expect(isDateFormat("mm:ss")).toBe(true);
  });

  it("texte, booléen, erreur", () => {
    expect(formatCell({ type: "text", value: "a" }, "@", "en")).toBe("a");
    expect(formatCell({ type: "bool", value: true }, null, "fr")).toBe("VRAI");
    expect(formatCell({ type: "error", value: "#N/A" }, null, "en")).toBe("#N/A");
    expect(formatCell({ type: "empty" }, "0.00", "en")).toBe("");
  });

  it("décimales", () => {
    expect(changeDecimals(null, 1)).toBe("0.0");
    expect(changeDecimals("0", 1)).toBe("0.0");
    expect(changeDecimals("0.00", 1)).toBe("0.000");
    expect(changeDecimals("0.00", -1)).toBe("0.0");
    expect(changeDecimals("0.0", -1)).toBe("0");
    expect(changeDecimals("0", -1)).toBe("0");
    expect(changeDecimals('#,##0.00 "€"', -1)).toBe('#,##0.0 "€"');
    expect(changeDecimals("0%", 1)).toBe("0.0%");
  });
});

describe("saisie", () => {
  it("formule, nombre, booléen, texte", () => {
    expect(parseCellInput("=A1+1", "en").f).toBe("A1+1");
    expect(parseCellInput("12.5", "en").v).toEqual({ type: "number", value: 12.5 });
    expect(parseCellInput("12,5", "fr").v).toEqual({ type: "number", value: 12.5 });
    expect(parseCellInput("1 234,5", "fr").v).toEqual({ type: "number", value: 1234.5 });
    expect(parseCellInput("true", "en").v).toEqual({ type: "bool", value: true });
    expect(parseCellInput("bonjour", "en").v).toEqual({ type: "text", value: "bonjour" });
    expect(parseCellInput("'42", "en").v).toEqual({ type: "text", value: "42" });
    expect(parseCellInput("=", "en").v).toEqual({ type: "text", value: "=" });
  });

  it("pourcentage et dates", () => {
    const p = parseCellInput("12%", "en");
    expect(p.v).toEqual({ type: "number", value: 0.12 });
    expect(p.fmt).toBe("0%");
    const d = parseCellInput("2024-03-05", "en");
    expect(d.v).toEqual({ type: "number", value: dateToSerial(2024, 3, 5) });
    expect(d.fmt).toBe("yyyy-mm-dd");
    expect(parseCellInput("05/03/2024", "fr").v).toEqual({
      type: "number",
      value: dateToSerial(2024, 3, 5),
    });
    expect(parseCellInput("2024-13-45", "en").v.type).toBe("text");
  });

  it("conserve le format précédent", () => {
    const c = parseCellInput("5", "en", num(1, "0.00"));
    expect(c.fmt).toBe("0.00");
    expect(parseCellInput("12", "en", { ...EMPTY_CELL, fmt: "@" }).v).toEqual({
      type: "text",
      value: "12",
    });
    expect(parseCellInput("", "en", num(1, "0.00"))).toEqual({
      v: { type: "empty" },
      f: null,
      fmt: "0.00",
    });
    expect(parseCellInput("=DATE(2024,1,1)", "en").fmt).toBe("yyyy-mm-dd");
  });

  it("texte d'édition", () => {
    expect(cellInputText(fx("SUM(A1:A3)"), "en")).toBe("=SUM(A1:A3)");
    expect(cellInputText(num(1.5), "fr")).toBe("1,5");
    expect(cellInputText(txt("42"), "en")).toBe("'42");
    expect(cellInputText(txt("abc"), "en")).toBe("abc");
    expect(cellInputText(num(dateToSerial(2024, 3, 5), "dd/mm/yyyy"), "en")).toBe("2024-03-05");
    expect(cellInputText(undefined, "en")).toBe("");
  });
});

describe("TSV", () => {
  it("aller-retour avec guillemets et retours à la ligne", () => {
    const grid = [
      ["a", "b\tc", 'd"e'],
      ["x\ny", "", "z"],
    ];
    expect(parseTsv(serializeTsv(grid))).toEqual(grid);
  });

  it("CRLF et fin de ligne finale", () => {
    expect(parseTsv("1\t2\r\n3\t4\r\n")).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parseTsv("a\t\tb")).toEqual([["a", "", "b"]]);
    expect(parseTsv("")).toEqual([]);
  });
});

describe("navigation Ctrl+flèche", () => {
  const filled = (r: number, c: number) => c === 0 && (r === 1 || r === 2 || r === 3 || r === 7);
  it("saute le bloc et les vides", () => {
    expect(ctrlArrow(filled, { r: 1, c: 0 }, 1, 0, 20, 5)).toEqual({ r: 3, c: 0 });
    expect(ctrlArrow(filled, { r: 3, c: 0 }, 1, 0, 20, 5)).toEqual({ r: 7, c: 0 });
    expect(ctrlArrow(filled, { r: 7, c: 0 }, 1, 0, 20, 5)).toEqual({ r: 19, c: 0 });
    expect(ctrlArrow(filled, { r: 7, c: 0 }, -1, 0, 20, 5)).toEqual({ r: 3, c: 0 });
    expect(ctrlArrow(filled, { r: 0, c: 0 }, -1, 0, 20, 5)).toEqual({ r: 0, c: 0 });
    expect(ctrlArrow(filled, { r: 1, c: 0 }, 0, 1, 20, 5)).toEqual({ r: 1, c: 4 });
  });
});

describe("historique", () => {
  it("annuler / rétablir", () => {
    const h = new History<number>();
    h.push(1);
    h.push(2);
    expect(h.undo()).toBe(2);
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toBe(2);
    h.undo();
    h.push(3);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe(3);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBeUndefined();
  });

  it("limite la taille", () => {
    const h = new History<number>(2);
    h.push(1);
    h.push(2);
    h.push(3);
    expect(h.undo()).toBe(3);
    expect(h.undo()).toBe(2);
    expect(h.undo()).toBeUndefined();
  });
});

describe("tri", () => {
  const rows: Cell[][] = [
    [txt("nom"), txt("n")],
    [txt("b"), num(3)],
    [txt("a"), num(1)],
    [txt("c"), { ...EMPTY_CELL }],
    [txt("d"), num(2)],
  ];
  const apply = (changes: ReturnType<typeof sortChanges>): Cell[][] => {
    const out = rows.map((r) => r.slice());
    for (const ch of changes) (out[ch.row] as Cell[])[ch.col] = ch.cell as Cell;
    return out;
  };

  it("croissant avec en-tête, vides à la fin", () => {
    const out = apply(sortChanges(rows, 0, { r1: 0, c1: 0, r2: 4, c2: 1 }, 1, true, true));
    expect(out.map((r) => (r[0]?.v as { value?: string }).value)).toEqual([
      "nom",
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("décroissant, vides toujours à la fin", () => {
    const out = apply(sortChanges(rows, 0, { r1: 1, c1: 0, r2: 4, c2: 1 }, 1, false, false));
    expect(out.map((r) => (r[0]?.v as { value?: string }).value)).toEqual([
      "nom",
      "b",
      "d",
      "a",
      "c",
    ]);
  });

  it("décale les formules relatives des lignes déplacées", () => {
    const data: Cell[][] = [
      [num(2), fx("A1*10")],
      [num(1), fx("A2*10")],
    ];
    const changes = sortChanges(data, 0, { r1: 0, c1: 0, r2: 1, c2: 1 }, 0, true, false);
    const moved = changes.find((c) => c.row === 0 && c.col === 1);
    expect(moved?.cell?.f).toBe("A1*10");
  });
});

describe("filtre", () => {
  const rows: Cell[][] = [[txt("h")], [txt("x")], [txt("y")], [txt("x")]];
  const display = (c: Cell | undefined) => (c?.v.type === "text" ? c.v.value : "");
  it("valeurs uniques et lignes visibles", () => {
    expect(uniqueValues(rows, 0, display)).toEqual(["x", "y"]);
    const v = visibleRows(rows, 6, { enabled: true, excluded: { 0: ["x"] } }, display);
    expect(v).toEqual([0, 2, 4, 5]);
    expect(visibleRows(rows, 6, { enabled: true, excluded: {} }, display)).toBeNull();
  });
});

describe("réécriture de formules", () => {
  it("décalage relatif", () => {
    expect(offsetFormula("A1+$B$2+C$3", 1, 1)).toBe("B2+$B$2+D$3");
    expect(offsetFormula("A1", -1, 0)).toBe("#REF!");
    expect(offsetFormula("SUM(A1:A3)", 2, 0)).toBe("SUM(A3:A5)");
  });

  it("insertion et suppression", () => {
    expect(adjustForStructure("A1+A5", "S", "S", "row", 2, 1)).toBe("A1+A6");
    expect(adjustForStructure("SUM(A1:A5)", "S", "S", "row", 2, 2)).toBe("SUM(A1:A7)");
    expect(adjustForStructure("A1+A5", "S", "S", "row", 2, -1)).toBe("A1+A4");
    expect(adjustForStructure("A3+1", "S", "S", "row", 2, -1)).toBe("#REF!+1");
    expect(adjustForStructure("SUM(A1:A5)", "S", "S", "row", 1, -2)).toBe("SUM(A1:A3)");
    expect(adjustForStructure("B1", "S", "S", "col", 0, 1)).toBe("C1");
    expect(adjustForStructure("A5", "S", "Autre", "row", 0, 1)).toBe("A5");
    expect(adjustForStructure("Autre!A5", "S", "Autre", "row", 0, 1)).toBe("Autre!A6");
  });

  it("renommage de feuille", () => {
    expect(renameSheetInFormula("Old!A1+B1", "Old", "Ma feuille")).toBe("'Ma feuille'!A1+B1");
  });
});

describe("structure", () => {
  const sheets = (): Sheet[] => [
    sheetOf("S1", [
      [num(1), num(2)],
      [num(3), fx("A2+B1")],
      [num(5), fx("SUM(A1:A3)")],
    ]),
    sheetOf("S2", [[fx("S1!A3*2")]]),
  ];
  const recalc = (s: Sheet[]) => {
    const e = new Engine({ locale: "en" });
    e.load(s);
    return e;
  };

  it("insère une ligne et adapte les formules, y compris inter-feuilles", () => {
    const out = insertAxis(sheets(), 0, "row", 1, 1);
    expect(out[0]?.rows.length).toBe(4);
    expect(out[0]?.rows[3]?.[1]?.f).toBe("SUM(A1:A4)");
    expect(out[1]?.rows[0]?.[0]?.f).toBe("'S1'!A4*2");
    const e = recalc(out);
    expect(e.getCell(0, 3, 1)?.v).toEqual({ type: "number", value: 9 });
  });

  it("supprime une colonne", () => {
    const out = deleteAxis(sheets(), 0, "col", 0, 1);
    expect(out[0]?.rows[0]).toHaveLength(1);
    expect(out[0]?.rows[1]?.[0]?.f).toBe("#REF!+A1");
  });

  it("feuilles : ajout, renommage, suppression, déplacement", () => {
    expect(addSheet(sheets(), "S3").map((s) => s.name)).toEqual(["S1", "S2", "S3"]);
    const r = renameSheet(sheets(), 0, "Données");
    expect(r[1]?.rows[0]?.[0]?.f).toBe("Données!A3*2");
    const d = deleteSheet(sheets(), 0);
    expect(d).toHaveLength(1);
    expect(d[0]?.rows[0]?.[0]?.f).toBe("#REF!*2");
    expect(moveSheet(sheets(), 0, 1).map((s) => s.name)).toEqual(["S2", "S1"]);
    expect(uniqueSheetName(sheets(), "S1")).toBe("S1 2");
    expect(uniqueSheetName(sheets(), "s2", 1)).toBe("s2");
  });
});

describe("sérialisation", () => {
  it("décode les cellules nues reçues du backend", () => {
    const wire = [
      null,
      1.5,
      "a",
      true,
      { v: { type: "error", value: "#N/A" }, f: null, fmt: null },
    ];
    const sheets = decodeSheets([
      { name: "S", rows: [wire] as unknown as Cell[][], colWidths: null },
    ]);
    const row = sheets[0]?.rows[0] ?? [];
    expect(row[0]).toBe(EMPTY_CELL);
    expect(row[1]).toEqual({ v: { type: "number", value: 1.5 }, f: null, fmt: null });
    expect(row[2]?.v).toEqual({ type: "text", value: "a" });
    expect(row[3]?.v).toEqual({ type: "bool", value: true });
    expect(row[4]?.v).toEqual({ type: "error", value: "#N/A" });
  });

  it("retire les lignes et cellules vides de fin, mappe #CYCLE!", () => {
    const rows: Cell[][] = [
      [num(1), EMPTY_CELL, EMPTY_CELL],
      [{ v: { type: "error", value: "#CYCLE!" }, f: "A2", fmt: null }],
      [EMPTY_CELL],
      [],
    ];
    const wb = buildWorkbook([{ name: "S", rows, colWidths: [0, null] }], null, ["merges"]);
    expect(wb.sheets[0]?.rows).toHaveLength(2);
    expect(wb.sheets[0]?.rows[0]).toHaveLength(1);
    expect(wb.sheets[0]?.rows[1]?.[0]?.v).toEqual({ type: "error", value: "#REF!" });
    expect(wb.sheets[0]?.colWidths).toBeNull();
    expect(wb.lossy).toEqual(["merges"]);
  });

  it("conserve les largeurs personnalisées et les valeurs recalculées", () => {
    const e = new Engine({ locale: "en" });
    e.load([{ name: "S", rows: [[num(2), fx("A1*3")]], colWidths: [10, null] }]);
    const wb = buildWorkbook(
      e.sheets,
      { delimiter: ",", quote: '"', encoding: "UTF-8", header: false },
      undefined,
    );
    expect(wb.sheets[0]?.rows[0]?.[1]).toEqual({
      v: { type: "number", value: 6 },
      f: "A1*3",
      fmt: null,
    });
    expect(wb.sheets[0]?.colWidths).toEqual([10, null]);
    expect(wb.csv?.delimiter).toBe(",");
    expect(usedExtent(e.sheets[0]?.rows ?? [])).toEqual({ rows: 1, cols: 2 });
  });
});
