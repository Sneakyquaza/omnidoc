import type { NotebookDoc } from "../../ipc/bindings";
import type { EditorView } from "../types";

const view: EditorView<NotebookDoc> = {
  kind: "notebook",
  namespace: "notebook",
  load: () => import("./NotebookEditor"),
};
export default view;
