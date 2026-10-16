import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  PALETTES,
  buildSrcdoc,
  clampSize,
  htmlToText,
  loadPosition,
  parseAnchor,
  progressPercent,
  savePosition,
  searchChapters,
} from "./logic";

describe("ebook logic", () => {
  it("analyse les ancres internes", () => {
    expect(parseAnchor("#chapter-3")).toEqual({ chapter: 3, id: null });
    expect(parseAnchor("#chapter-12--sec-1")).toEqual({ chapter: 12, id: "chapter-12--sec-1" });
    expect(parseAnchor("https://example.com")).toBeNull();
    expect(parseAnchor("#autre")).toBeNull();
  });

  it("calcule la progression", () => {
    expect(progressPercent(0, 4, 0)).toBe(0);
    expect(progressPercent(1, 4, 0.5)).toBe(38);
    expect(progressPercent(3, 4, 1)).toBe(100);
    expect(progressPercent(0, 0, 0)).toBe(0);
  });

  it("borne la taille de police", () => {
    expect(clampSize(2)).toBe(12);
    expect(clampSize(99)).toBe(32);
    expect(clampSize(18.4)).toBe(18);
  });

  it("extrait le texte et cherche", () => {
    expect(htmlToText("<p>Bonjour  <b>le</b> monde</p>")).toBe("Bonjour le monde");
    const hits = searchChapters(
      [
        { title: "a", html: "<p>Un chat</p>" },
        { title: "b", html: "<p>chat et CHAT</p>" },
      ],
      "chat",
    );
    expect(hits.map((h) => h.chapter)).toEqual([0, 1, 1]);
    expect(searchChapters([], "  ")).toEqual([]);
  });

  it("construit un srcdoc sans script", () => {
    const doc = buildSrcdoc("<p>x</p>", DEFAULT_SETTINGS, PALETTES.sepia);
    expect(doc).toContain("<main><p>x</p></main>");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain(PALETTES.sepia.bg);
  });

  describe("position", () => {
    beforeEach(() => localStorage.clear());
    it("aller-retour et validation", () => {
      savePosition("/a.epub", { chapter: 2, fraction: 0.4 });
      expect(loadPosition("/a.epub", 5)).toEqual({ chapter: 2, fraction: 0.4 });
      expect(loadPosition("/a.epub", 2)).toBeNull();
      expect(loadPosition("/autre.epub", 5)).toBeNull();
    });
  });
});
