import { describe, expect, it } from "vitest";
import { formatTime, parseTime } from "./time";

describe("formatTime", () => {
  it("formate mm:ss.mmm", () => {
    expect(formatTime(0)).toBe("00:00.000");
    expect(formatTime(65432)).toBe("01:05.432");
    expect(formatTime(65432, false)).toBe("01:05");
  });
  it("ajoute les heures", () => {
    expect(formatTime(3_725_005)).toBe("1:02:05.005");
  });
  it("gère les valeurs invalides", () => {
    expect(formatTime(-5)).toBe("00:00.000");
    expect(formatTime(Number.NaN)).toBe("00:00.000");
  });
});

describe("parseTime", () => {
  it("analyse les formats usuels", () => {
    expect(parseTime("12")).toBe(12000);
    expect(parseTime("1:05")).toBe(65000);
    expect(parseTime("01:05.432")).toBe(65432);
    expect(parseTime("1:02:05.5")).toBe(3_725_500);
    expect(parseTime("0:01,25")).toBe(1250);
    expect(parseTime(" 2:00 ")).toBe(120000);
  });
  it("rejette les valeurs invalides", () => {
    expect(parseTime("")).toBeNull();
    expect(parseTime("abc")).toBeNull();
    expect(parseTime("1:75")).toBeNull();
    expect(parseTime("1:61:00")).toBeNull();
    expect(parseTime("-3")).toBeNull();
    expect(parseTime("1.2345")).toBeNull();
  });
  it("aller-retour", () => {
    for (const ms of [0, 1, 999, 61_001, 3_600_000]) {
      expect(parseTime(formatTime(ms))).toBe(ms);
    }
  });
});
