import { describe, expect, it } from "vitest";
import type { ExternalTool, HandlerInfo } from "../ipc/bindings";
import { externalOptions, internalOptions } from "./exportOptions";

const tools = (...names: string[]): ExternalTool[] =>
  names.map((name) => ({ name, path: `/usr/bin/${name}` }));

const handler = (id: string, write: boolean, model = "richText"): HandlerInfo =>
  ({ id, model, capabilities: { write }, extensions: [id] }) as unknown as HandlerInfo;

describe("options d'export", () => {
  it("propose LibreOffice pour un docx, sans la même extension", () => {
    const opts = externalOptions("DOCX", tools("soffice"));
    expect(opts.map((o) => (o.kind === "external" ? o.ext : ""))).toEqual(["pdf", "odt"]);
  });

  it("propose pandoc pour du markdown", () => {
    const opts = externalOptions("md", tools("pandoc"));
    expect(opts.map((o) => (o.kind === "external" ? o.ext : ""))).toEqual([
      "html",
      "docx",
      "odt",
      "epub",
    ]);
  });

  it("n'offre rien sans moteur ou pour un format inconnu", () => {
    expect(externalOptions("docx", [])).toEqual([]);
    expect(externalOptions("png", tools("soffice", "pandoc"))).toEqual([]);
  });

  it("cibles internes : exportTo sinon handlers inscriptibles du modèle", () => {
    const hs = [handler("a", true), handler("b", true), handler("c", false)];
    expect(internalOptions(hs, ["b", "c"], "richText").map((o) => o.id)).toEqual(["int-b"]);
    expect(internalOptions(hs, [], "richText").map((o) => o.id)).toEqual(["int-a", "int-b"]);
  });
});
