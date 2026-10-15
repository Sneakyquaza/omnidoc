import { describe, expect, it } from "vitest";
import {
  clampZoom,
  countWords,
  estimatePages,
  formatFontSize,
  lossyKind,
  normalizeDoc,
  parseFontSize,
} from "./normalize";

describe("normalizeDoc", () => {
  it("supprime textAlign left et les attrs inconnus", () => {
    const out = normalizeDoc({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { textAlign: "left" }, content: [{ type: "text", text: "a" }] },
        { type: "paragraph", attrs: { textAlign: "center", class: "x" } },
        { type: "heading", attrs: { level: 2, textAlign: null } },
      ],
    });
    expect(out).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "a" }] },
        { type: "paragraph", attrs: { textAlign: "center" } },
        { type: "heading", attrs: { level: 2 } },
      ],
    });
  });

  it("normalise les marques", () => {
    const out = normalizeDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "x",
              marks: [
                {
                  type: "link",
                  attrs: { href: "https://a.b", target: "_blank", rel: "n", class: null },
                },
                { type: "textStyle", attrs: { color: "#f00", fontFamily: null, fontSize: "12pt" } },
                { type: "textStyle", attrs: { color: null } },
                { type: "highlight", attrs: { color: "#ff0" } },
                { type: "bold", attrs: {} },
                { type: "weird" },
              ],
            },
          ],
        },
      ],
    }) as { content: { content: { marks: unknown[] }[] }[] };
    expect(out.content[0]?.content[0]?.marks).toEqual([
      { type: "link", attrs: { href: "https://a.b" } },
      { type: "textStyle", attrs: { color: "#f00", fontSize: "12pt" } },
      { type: "highlight", attrs: { color: "#ff0" } },
      { type: "bold" },
    ]);
  });

  it("gère listes, tâches, images et cellules", () => {
    const out = normalizeDoc({
      type: "doc",
      content: [
        { type: "orderedList", attrs: { start: 3, type: null } },
        { type: "taskItem", attrs: { checked: true } },
        {
          type: "image",
          attrs: { src: "data:x", alt: null, title: null, width: "120", height: null },
        },
        { type: "tableCell", attrs: { colspan: 2, colwidth: null } },
      ],
    });
    expect(out).toEqual({
      type: "doc",
      content: [
        { type: "orderedList", attrs: { start: 3 } },
        { type: "taskItem", attrs: { checked: true } },
        { type: "image", attrs: { src: "data:x", width: 120 } },
        { type: "tableCell", attrs: { colspan: 2, rowspan: 1 } },
      ],
    });
  });
});

describe("tailles et comptes", () => {
  it("convertit les tailles", () => {
    expect(parseFontSize("12pt")).toBe(12);
    expect(parseFontSize("16px")).toBe(12);
    expect(parseFontSize("abc")).toBeNull();
    expect(formatFontSize(100)).toBe("72pt");
    expect(formatFontSize(2)).toBe("8pt");
    expect(formatFontSize(10.5)).toBe("10.5pt");
  });

  it("compte les mots", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("Bonjour le monde, c'est l'été !")).toBe(5);
    expect(countWords("a-b c")).toBe(2);
  });

  it("estime les pages et borne le zoom", () => {
    expect(estimatePages(0)).toBe(1);
    expect(estimatePages(501)).toBe(2);
    expect(clampZoom(300)).toBe(200);
    expect(clampZoom(10)).toBe(50);
  });

  it("classe les clés lossy", () => {
    expect(lossyKind("footnotes").kind).toBe("known");
    expect(lossyKind("node:foo")).toEqual({ kind: "node", name: "foo" });
    expect(lossyKind("mark:bar")).toEqual({ kind: "mark", name: "bar" });
    expect(lossyKind("zzz").kind).toBe("other");
  });
});
