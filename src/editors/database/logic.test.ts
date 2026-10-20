import { describe, expect, it } from "vitest";
import {
  BLOCK_SIZE,
  affinity,
  blockOf,
  defaultColumnDef,
  editText,
  formatValue,
  inputFor,
  isEditableValue,
  moveCell,
  nextCell,
  nextSelection,
  rowCountLabel,
  validColumnDefs,
  validColumnType,
  validObjectName,
} from "./logic";

describe("database logic", () => {
  it("formate les valeurs", () => {
    expect(formatValue({ type: "null" })).toBe("NULL");
    expect(formatValue({ type: "int", value: "9007199254740993" })).toBe("9007199254740993");
    expect(formatValue({ type: "int", value: 42 })).toBe("42");
    expect(formatValue({ type: "real", value: 1.5 })).toBe("1.5");
    expect(formatValue({ type: "text", value: "a" })).toBe("a");
  });
  it("préfixe « ~ » si le comptage n'est pas exact", () => {
    expect(rowCountLabel({ rowCount: 12, rowCountExact: true })).toBe("12");
    expect(rowCountLabel({ rowCount: 12 })).toBe("12");
    expect(rowCountLabel({ rowCount: 0, rowCountExact: false })).toBe("~");
  });
  it("calcule le bloc", () => {
    expect(blockOf(0)).toBe(0);
    expect(blockOf(BLOCK_SIZE)).toBe(1);
  });
  it("déduit l'affinité et la valeur saisie", () => {
    expect(affinity("INTEGER")).toBe("integer");
    expect(affinity("VARCHAR(20)")).toBe("text");
    expect(affinity("")).toBe("blob");
    expect(affinity("DOUBLE")).toBe("real");
    expect(affinity("DATE")).toBe("numeric");
    expect(inputFor("", "INTEGER")).toEqual({ type: "null" });
    expect(inputFor("", "TEXT")).toEqual({ type: "text", value: "" });
    expect(inputFor("12", "INTEGER")).toEqual({ type: "text", value: "12" });
  });
  it("texte d'édition et cellules éditables", () => {
    expect(editText({ type: "null" })).toBe("");
    expect(editText({ type: "int", value: 4 })).toBe("4");
    expect(editText(undefined)).toBe("");
    expect(isEditableValue({ type: "blob", value: "<blob 1 octets> 00" })).toBe(false);
    expect(isEditableValue({ type: "null" })).toBe(true);
    expect(isEditableValue(undefined)).toBe(false);
  });
  it("navigue entre les cellules", () => {
    expect(moveCell({ row: 0, col: 0 }, "ArrowUp", 3, 2)).toEqual({ row: 0, col: 0 });
    expect(moveCell({ row: 2, col: 1 }, "ArrowDown", 3, 2)).toEqual({ row: 2, col: 1 });
    expect(moveCell({ row: 1, col: 0 }, "ArrowRight", 3, 2)).toEqual({ row: 1, col: 1 });
    expect(moveCell({ row: 1, col: 1 }, "Home", 3, 2)).toEqual({ row: 1, col: 0 });
    expect(nextCell({ row: 0, col: 1 }, 2, 2)).toEqual({ row: 1, col: 0 });
    expect(nextCell({ row: 1, col: 1 }, 2, 2)).toBeNull();
    expect(nextCell({ row: 0, col: 0 }, 2, 2, true)).toBeNull();
  });
  it("gère la sélection de lignes", () => {
    const none = new Set<number>();
    const a = nextSelection(none, null, 2, { shift: false, ctrl: false });
    expect([...a.selected]).toEqual([2]);
    const b = nextSelection(a.selected, a.anchor, 4, { shift: true, ctrl: false });
    expect([...b.selected].sort()).toEqual([2, 3, 4]);
    const c = nextSelection(b.selected, b.anchor, 3, { shift: false, ctrl: true });
    expect([...c.selected].sort()).toEqual([2, 4]);
  });
  it("valide les définitions", () => {
    expect(validColumnDefs([defaultColumnDef()])).toBe(true);
    expect(validColumnDefs([])).toBe(false);
    expect(validColumnDefs([defaultColumnDef(), { ...defaultColumnDef(), name: "ID" }])).toBe(
      false,
    );
    expect(validObjectName("  ")).toBe(false);
    expect(validObjectName("sqlite_x")).toBe(false);
    expect(validObjectName("t")).toBe(true);
    expect(validColumnType("VARCHAR(20)")).toBe(true);
    expect(validColumnType("TEXT); DROP")).toBe(false);
  });
});
