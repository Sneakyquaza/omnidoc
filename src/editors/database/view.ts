import type { DbDoc } from "../../ipc/bindings";
import type { EditorView } from "../types";

const view: EditorView<DbDoc> = {
  kind: "database",
  namespace: "database",
  load: () => import("./DatabaseEditor"),
};
export default view;
