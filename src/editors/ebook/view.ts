import type { EbookDoc } from "../../ipc/bindings";
import type { EditorView } from "../types";

const view: EditorView<EbookDoc> = {
  kind: "ebook",
  namespace: "ebook",
  load: () => import("./EbookEditor"),
};
export default view;
