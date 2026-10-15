import { describe, expect, it } from "vitest";
import { rectsToQuads, strokeBounds, toPdf, toViewport, viewportSize } from "./geometry";
import type { PageGeometry } from "./geometry";
import { nextSelection, reorderPages } from "./pages";
import { parsePageRanges } from "./ranges";
import { findMatches } from "./search";

describe("parsePageRanges", () => {
  it("accepte pages et plages", () => {
    expect(parsePageRanges("1-3, 5, 7-9", 10)).toEqual({
      ok: true,
      ranges: [
        { start: 1, end: 3 },
        { start: 5, end: 5 },
        { start: 7, end: 9 },
      ],
    });
  });
  it("valide les bornes et la syntaxe", () => {
    expect(parsePageRanges("", 10)).toEqual({ ok: false, error: "empty" });
    expect(parsePageRanges(" , ", 10)).toEqual({ ok: false, error: "empty" });
    expect(parsePageRanges("0-2", 10)).toEqual({ ok: false, error: "bounds" });
    expect(parsePageRanges("8-11", 10)).toEqual({ ok: false, error: "bounds" });
    expect(parsePageRanges("5-3", 10)).toEqual({ ok: false, error: "order" });
    expect(parsePageRanges("a-3", 10)).toEqual({ ok: false, error: "syntax" });
    expect(parsePageRanges("1-2-3", 10)).toEqual({ ok: false, error: "syntax" });
  });
});

const view: [number, number, number, number] = [0, 0, 200, 100];
const geo = (rotation: number, scale = 2): PageGeometry => ({ view, rotation, scale });

describe("conversion viewport <-> PDF", () => {
  it("rotation 0 : origine bas-gauche vers haut-gauche", () => {
    expect(toViewport(geo(0), 0, 100)).toEqual([0, 0]);
    expect(toViewport(geo(0), 200, 0)).toEqual([400, 200]);
    expect(viewportSize(geo(0))).toEqual({ width: 400, height: 200 });
  });
  it("rotation 90 : le coin haut-gauche PDF passe en haut-droite", () => {
    expect(toViewport(geo(90), 0, 100)).toEqual([200, 0]);
    expect(viewportSize(geo(90))).toEqual({ width: 200, height: 400 });
  });
  it("rotation 180 et 270", () => {
    expect(toViewport(geo(180), 0, 100)).toEqual([400, 200]);
    expect(toViewport(geo(270), 0, 100)).toEqual([0, 400]);
  });
  it("aller-retour pour toutes les rotations et un viewBox décalé", () => {
    for (const rotation of [0, 90, 180, 270, 450, -90]) {
      const g: PageGeometry = { view: [10, 20, 310, 420], rotation, scale: 1.5 };
      const [vx, vy] = toViewport(g, 123, 77);
      const [x, y] = toPdf(g, vx, vy);
      expect(x).toBeCloseTo(123);
      expect(y).toBeCloseTo(77);
    }
  });
});

describe("rectsToQuads", () => {
  it("produit un quad HG, HD, BG, BD en espace PDF (rotation 0)", () => {
    const r = rectsToQuads(geo(0, 1), [{ left: 10, top: 10, right: 50, bottom: 30 }]);
    expect(r?.quads).toEqual([10, 90, 50, 90, 10, 70, 50, 70]);
    expect(r?.rect).toEqual([10, 70, 50, 90]);
  });
  it("tient compte de la rotation", () => {
    const r = rectsToQuads(geo(90, 1), [{ left: 0, top: 0, right: 20, bottom: 10 }]);
    // viewport 100 x 200 ; (vx, vy) -> (x, y) = (vy, vx)
    expect(r?.quads).toEqual([0, 0, 0, 20, 10, 0, 10, 20]);
    expect(r?.rect).toEqual([0, 0, 10, 20]);
  });
  it("ignore les rectangles dégénérés, inclus ou dupliqués", () => {
    const big = { left: 0, top: 0, right: 100, bottom: 20 };
    const r = rectsToQuads(geo(0, 1), [
      big,
      { left: 10, top: 2, right: 30, bottom: 18 },
      { ...big },
      { left: 5, top: 5, right: 5.2, bottom: 15 },
    ]);
    expect(r?.quads).toHaveLength(8);
    expect(rectsToQuads(geo(0, 1), [])).toBeNull();
  });
  it("encadre un tracé", () => {
    expect(strokeBounds([1, 2, 5, 9, 3, 4], 1)).toEqual([0, 1, 6, 10]);
  });
});

describe("pages", () => {
  it("réordonne un bloc", () => {
    expect(reorderPages(5, [4, 5], 1)).toEqual([4, 5, 1, 2, 3]);
    expect(reorderPages(5, [1], 4)).toEqual([2, 3, 1, 4, 5]);
    expect(reorderPages(5, [2, 3], 6)).toEqual([1, 4, 5, 2, 3]);
  });
  it("gère la sélection", () => {
    const none = { ctrl: false, shift: false };
    expect(nextSelection([1], 1, 3, { ...none, shift: true })).toEqual([1, 2, 3]);
    expect(nextSelection([1], 1, 3, { ...none, ctrl: true })).toEqual([1, 3]);
    expect(nextSelection([1, 3], 1, 3, { ...none, ctrl: true })).toEqual([1]);
    expect(nextSelection([1, 3], 1, 2, none)).toEqual([2]);
  });
});

describe("findMatches", () => {
  it("trouve dans un élément et à cheval sur deux", () => {
    expect(findMatches(["Hello wor", "ld foo"], "WORLD")).toEqual([
      { startItem: 0, startOffset: 6, endItem: 1, endOffset: 2 },
    ]);
    expect(findMatches(["aa", "a"], "a")).toHaveLength(3);
    expect(findMatches(["abc"], "")).toEqual([]);
  });
});
