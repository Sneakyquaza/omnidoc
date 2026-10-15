import type { ModelKind } from "../ipc/bindings";
import type { AnyEditorView } from "./types";

/**
 * Seul endroit qui liste les éditeurs : une ligne par éditeur
 * (remplacer `undefined` par `{ kind, namespace, load: () => import("./x/XEditor") }`).
 */
export const editors: Record<ModelKind, AnyEditorView | undefined> = {
  text: undefined,
  richText: undefined,
  sheet: undefined,
  image: undefined,
  pdf: undefined,
  archive: undefined,
  media: undefined,
  database: undefined,
  records: undefined,
  notebook: undefined,
  ebook: undefined,
  slides: undefined,
  binary: { kind: "binary", namespace: "hex", load: () => import("./hex/HexEditor") },
};
