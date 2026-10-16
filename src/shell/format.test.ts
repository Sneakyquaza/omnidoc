import { describe, expect, it } from "vitest";
import { formatDate, formatSize } from "./format";

describe("formatSize", () => {
  it("français : o / Ko / Mo, virgule décimale", () => {
    expect(formatSize(0, "fr")).toBe("0 o");
    expect(formatSize(4, "fr")).toBe("4 o");
    expect(formatSize(1536, "fr")).toBe("1,5 Ko");
    expect(formatSize(5 * 1024 * 1024, "fr")).toBe("5,0 Mo");
    expect(formatSize(200 * 1024, "fr")).toBe("200 Ko");
  });
  it("anglais : B / KB / MB, point décimal", () => {
    expect(formatSize(4, "en")).toBe("4 B");
    expect(formatSize(1536, "en")).toBe("1.5 KB");
    expect(formatSize(5 * 1024 * 1024, "en")).toBe("5.0 MB");
  });
});

describe("formatDate", () => {
  it("valeurs absentes ou invalides → chaîne vide", () => {
    expect(formatDate(null, "fr")).toBe("");
    expect(formatDate("pas une date", "fr")).toBe("");
    expect(formatDate("2024-03-05T10:20:00Z", "fr")).not.toBe("");
  });
});
