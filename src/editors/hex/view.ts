import type { BinaryDoc } from "../../ipc/bindings";
import type { EditorView } from "../types";

const view: EditorView<BinaryDoc> = {
  kind: "binary",
  namespace: "hex",
  load: () => import("./HexEditor"),
};
export default view;
