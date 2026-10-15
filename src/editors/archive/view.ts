import type { ArchiveDoc } from "../../ipc/bindings";
import type { EditorView } from "../types";

const view: EditorView<ArchiveDoc> = {
  kind: "archive",
  namespace: "archive",
  load: () => import("./ArchiveEditor"),
};
export default view;
