import type { PdfDoc } from "../../ipc/bindings";
import type { EditorView } from "../types";

const view: EditorView<PdfDoc> = {
  kind: "pdf",
  namespace: "pdf",
  load: () => import("./PdfEditor"),
};
export default view;
