import type { DocumentModel, ModelKind } from "../ipc/bindings";

export interface NewDocumentKind {
  id: string;
  /** Clé i18n du libellé. */
  labelKey: string;
  handlerId: string;
  modelKind: ModelKind;
  /** `sheetName` : nom (traduit) de la première feuille. */
  build(sheetName: string): DocumentModel;
}

function text(language: string): DocumentModel {
  return { kind: "text", text: "", encoding: "UTF-8", bom: false, lineEnding: "lf", language };
}

export const SHEET_ROWS = 50;
export const SHEET_COLS = 26;

export const NEW_DOCUMENTS: NewDocumentKind[] = [
  {
    id: "text",
    labelKey: "newDoc.text",
    handlerId: "text",
    modelKind: "text",
    build: () => text("plaintext"),
  },
  {
    id: "rich",
    labelKey: "newDoc.rich",
    handlerId: "docx",
    modelKind: "richText",
    build: () => ({
      kind: "richText",
      doc: { type: "doc", content: [{ type: "paragraph" }] },
      meta: { title: null, author: null },
      lossy: [],
    }),
  },
  {
    id: "sheet",
    labelKey: "newDoc.sheet",
    handlerId: "xlsx",
    modelKind: "sheet",
    build: (sheetName) => ({
      kind: "sheet",
      sheets: [
        {
          name: sheetName,
          rows: Array.from({ length: SHEET_ROWS }, () =>
            Array.from({ length: SHEET_COLS }, () => ({
              v: { type: "empty" as const },
              f: null,
              fmt: null,
            })),
          ),
          colWidths: null,
        },
      ],
      csv: null,
    }),
  },
  {
    id: "markdown",
    labelKey: "newDoc.markdown",
    handlerId: "markdown",
    modelKind: "text",
    build: () => text("markdown"),
  },
  {
    id: "json",
    labelKey: "newDoc.json",
    handlerId: "text",
    modelKind: "text",
    build: () => text("json"),
  },
];
