import type { Workbook } from "../../ipc/bindings";
import type { EditorView } from "../types";

const view: EditorView<Workbook> = {
  kind: "sheet",
  namespace: "sheet",
  load: () => import("./SheetEditor"),
};
export default view;
