import type { ImageDoc } from "../../ipc/bindings";
import type { EditorView } from "../types";

const view: EditorView<ImageDoc> = {
  kind: "image",
  namespace: "image",
  load: () => import("./ImageEditor"),
};
export default view;
