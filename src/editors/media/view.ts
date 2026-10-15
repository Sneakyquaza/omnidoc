import type { MediaDoc } from "../../ipc/bindings";
import type { EditorView } from "../types";

const view: EditorView<MediaDoc> = {
  kind: "media",
  namespace: "media",
  load: () => import("./MediaEditor"),
};
export default view;
