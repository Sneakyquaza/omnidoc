import { describe, expect, it } from "vitest";
import { clampIndex, isSafeThumbnail, slideBullets, slideTitle } from "./logic";

const slide = (texts: string[]) => ({ index: 1, texts, notes: null });

describe("slides logic", () => {
  it("sépare titre et puces", () => {
    expect(slideTitle(slide(["", "Titre", "a", " ", "b"]))).toBe("Titre");
    expect(slideBullets(slide(["", "Titre", "a", " ", "b"]))).toEqual(["a", "b"]);
    expect(slideTitle(slide([]))).toBe("");
    expect(slideBullets(slide([]))).toEqual([]);
  });
  it("borne l'index", () => {
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(1, 3)).toBe(1);
  });
  it("valide la miniature", () => {
    expect(isSafeThumbnail("data:image/png;base64,AA==")).toBe(true);
    expect(isSafeThumbnail("http://x/y.png")).toBe(false);
    expect(isSafeThumbnail(null)).toBe(false);
  });
});
