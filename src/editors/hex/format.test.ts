import { describe, expect, it } from "vitest";
import {
  asciiChar,
  describeValues,
  findInBuffer,
  formatOffset,
  hex,
  parseHexPattern,
  parseOffset,
} from "./format";

describe("formatage hexadécimal", () => {
  it("formate octets, offsets, tailles", () => {
    expect(hex(10)).toBe("0A");
    expect(hex(255, 4)).toBe("00FF");
    expect(formatOffset(4096)).toBe("0x00001000");
    expect(asciiChar(65)).toBe("A");
    expect(asciiChar(0)).toBe(".");
    expect(asciiChar(0x7f)).toBe(".");
  });

  it("analyse les offsets", () => {
    expect(parseOffset("4096")).toBe(4096);
    expect(parseOffset(" 0x1F ")).toBe(31);
    expect(parseOffset("1F")).toBeNull();
    expect(parseOffset("-3")).toBeNull();
    expect(parseOffset("")).toBeNull();
  });

  it("analyse les motifs hexadécimaux", () => {
    expect(Array.from(parseHexPattern("de ad BE ef") ?? [])).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(Array.from(parseHexPattern("0x4d5a") ?? [])).toEqual([0x4d, 0x5a]);
    expect(parseHexPattern("abc")).toBeNull();
    expect(parseHexPattern("zz")).toBeNull();
    expect(parseHexPattern("")).toBeNull();
  });

  it("calcule les valeurs petit-boutistes", () => {
    const data = [0xff, 0x01, 0x02, 0x80];
    const v = describeValues((o) => data[o], 0);
    expect(v).toEqual({ u8: 255, i8: -1, u16: 0x01ff, u32: 0x800201ff });
    expect(describeValues((o) => data[o], 3)).toEqual({ u8: 128, i8: -128 });
    expect(describeValues((o) => data[o], 9)).toBeNull();
  });

  it("cherche une séquence", () => {
    const buf = new Uint8Array([1, 2, 3, 1, 2, 4]);
    expect(findInBuffer(buf, new Uint8Array([1, 2, 4]), 0)).toBe(3);
    expect(findInBuffer(buf, new Uint8Array([1, 2]), 1)).toBe(3);
    expect(findInBuffer(buf, new Uint8Array([4, 5]), 0)).toBe(-1);
    expect(findInBuffer(buf, new Uint8Array([]), 0)).toBe(-1);
  });
});
