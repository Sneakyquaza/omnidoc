// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { buildExtensions } from "./extensions";
import { normalizeDoc } from "./normalize";
import { findMatches } from "./search";

const text = (t: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({
  type: "text",
  text: t,
  ...(marks ? { marks } : {}),
});

const DOC = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2, textAlign: "center" }, content: [text("Titre")] },
    {
      type: "paragraph",
      attrs: { textAlign: "justify" },
      content: [
        text("gras", [{ type: "bold" }]),
        text(" lien", [{ type: "link", attrs: { href: "https://exemple.org" } }]),
        text(" style", [
          { type: "textStyle", attrs: { color: "#c62828", fontFamily: "serif", fontSize: "14pt" } },
          { type: "highlight", attrs: { color: "#fff59d" } },
        ]),
        { type: "image", attrs: { src: "data:image/png;base64,AAAA", width: 100 } },
      ],
    },
    {
      type: "orderedList",
      attrs: { start: 3 },
      content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("un")] }] }],
    },
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: true },
          content: [{ type: "paragraph", content: [text("fait")] }],
        },
      ],
    },
    { type: "codeBlock", attrs: { language: "rust" }, content: [text("fn main() {}")] },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: { colspan: 1, rowspan: 1 },
              content: [{ type: "paragraph", content: [text("H")] }],
            },
            {
              type: "tableCell",
              attrs: { colspan: 1, rowspan: 1 },
              content: [{ type: "paragraph", content: [text("C")] }],
            },
          ],
        },
      ],
    },
    { type: "horizontalRule" },
  ],
};

describe("schéma TipTap", () => {
  it("aller-retour : charger puis normaliser redonne le document Rust", () => {
    const editor = new Editor({ extensions: buildExtensions(""), content: DOC });
    expect(normalizeDoc(editor.getJSON())).toEqual(DOC);
    editor.destroy();
  });

  it("trouve les occurrences (casse optionnelle)", () => {
    const editor = new Editor({
      extensions: buildExtensions(""),
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [text("Abc abc ABC")] }],
      },
    });
    expect(findMatches(editor.state.doc, "abc", false)).toHaveLength(3);
    expect(findMatches(editor.state.doc, "abc", true)).toHaveLength(1);
    expect(findMatches(editor.state.doc, "", false)).toHaveLength(0);
    editor.destroy();
  });
});
