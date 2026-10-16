import type { ExternalTool, HandlerInfo } from "../ipc/bindings";

/** Cible d'export : conversion interne (handler cible) ou moteur externe détecté. */
export type ExportOption =
  | { kind: "internal"; id: string; handler: HandlerInfo }
  | { kind: "external"; id: string; tool: string; engine: "libreoffice" | "pandoc"; ext: string };

const LIBREOFFICE_TARGETS: Array<{ from: string[]; to: string[] }> = [
  { from: ["docx", "odt", "rtf", "doc"], to: ["pdf", "docx", "odt"] },
  { from: ["xlsx", "ods", "xls", "csv"], to: ["pdf", "xlsx", "ods"] },
  { from: ["pptx", "odp"], to: ["pdf"] },
];
const PANDOC_SOURCES = ["md", "markdown", "html", "docx", "odt"];
const PANDOC_TARGETS = ["md", "html", "docx", "odt", "epub"];

/** Clé i18n `common:formats.*` du libellé d'une extension cible. */
const FORMAT_KEYS: Record<string, string> = {
  pdf: "formats.pdf",
  docx: "formats.docx",
  odt: "formats.odt",
  xlsx: "formats.xlsx",
  ods: "formats.ods",
  md: "formats.markdown",
  html: "formats.html",
  epub: "formats.epub",
};

export function formatKeyOf(ext: string): string | undefined {
  return FORMAT_KEYS[ext];
}

function canonicalExt(ext: string): string {
  return ext === "markdown" ? "md" : ext;
}

/** Cibles possibles par moteurs externes pour une extension source, selon les outils détectés. */
export function externalOptions(sourceExt: string, tools: ExternalTool[]): ExportOption[] {
  const src = canonicalExt(sourceExt.toLowerCase());
  const options: ExportOption[] = [];
  const office =
    tools.find((t) => t.name === "soffice") ?? tools.find((t) => t.name === "libreoffice");
  if (office) {
    const entry = LIBREOFFICE_TARGETS.find((e) => e.from.includes(src));
    for (const ext of entry?.to ?? []) {
      if (ext !== src) {
        options.push({
          kind: "external",
          id: `lo-${ext}`,
          tool: office.name,
          engine: "libreoffice",
          ext,
        });
      }
    }
  }
  const pandoc = tools.find((t) => t.name === "pandoc");
  if (pandoc && PANDOC_SOURCES.includes(src)) {
    for (const ext of PANDOC_TARGETS) {
      if (ext !== src) {
        options.push({
          kind: "external",
          id: `pandoc-${ext}`,
          tool: pandoc.name,
          engine: "pandoc",
          ext,
        });
      }
    }
  }
  return options;
}

/** Cibles internes : `exportTo` du handler source, sinon handlers inscriptibles du même modèle. */
export function internalOptions(
  handlers: HandlerInfo[],
  exportTo: string[],
  modelKind: string,
): ExportOption[] {
  let targets = handlers.filter((h) => exportTo.includes(h.id) && h.capabilities.write);
  if (targets.length === 0) {
    targets = handlers.filter((h) => h.model === modelKind && h.capabilities.write);
  }
  return targets.map((handler) => ({ kind: "internal", id: `int-${handler.id}`, handler }));
}
