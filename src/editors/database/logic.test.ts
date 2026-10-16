import { describe, expect, it } from "vitest";
import { BLOCK_SIZE, blockOf, formatValue, rowCountLabel } from "./logic";

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
});
