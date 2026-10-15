import { describe, expect, it } from "vitest";
import { formatBytes, formatFromPath, isLossy, saveFormatOf, stripDataUri, toHex } from "./formats";

describe("formats d'image", () => {
  it("déduit le format de l'extension", () => {
    expect(formatFromPath("/a/b/photo.JPG")).toBe("jpeg");
    expect(formatFromPath("C:\\x\\y.tif")).toBe("tiff");
    expect(formatFromPath("/a/b/noext")).toBeNull();
    expect(formatFromPath("/a/b/v.svg")).toBeNull();
  });
  it("associe le format du modèle", () => {
    expect(saveFormatOf("jpeg")).toBe("jpeg");
    expect(saveFormatOf("svg")).toBeNull();
    expect(isLossy("webp")).toBe(true);
    expect(isLossy("png")).toBe(false);
  });
  it("utilitaires", () => {
    expect(toHex(255, 0, 16)).toBe("#ff0010");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(12)).toBe("12 B");
    expect(stripDataUri("data:image/png;base64,AAAA")).toBe("AAAA");
  });
});
