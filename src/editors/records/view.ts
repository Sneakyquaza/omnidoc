import type { RecordsDoc } from "../../ipc/bindings";
import type { EditorView } from "../types";

const view: EditorView<RecordsDoc> = {
  kind: "records",
  namespace: "records",
  load: () => import("./RecordsEditor"),
};
export default view;
