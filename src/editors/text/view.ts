import type { TextDoc } from "../../ipc/bindings";
import type { EditorView } from "../types";

const view: EditorView<TextDoc> = {
  kind: "text",
  namespace: "text",
  load: () => import("./TextEditor"),
};
export default view;
