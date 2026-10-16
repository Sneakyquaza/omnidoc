import type { SlidesDoc } from "../../ipc/bindings";
import type { EditorView } from "../types";

const view: EditorView<SlidesDoc> = {
  kind: "slides",
  namespace: "slides",
  load: () => import("./SlidesEditor"),
};
export default view;
