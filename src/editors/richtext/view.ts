import type { RichDoc } from "../../ipc/bindings";
import type { EditorView } from "../types";

const view: EditorView<RichDoc> = {
  kind: "richText",
  namespace: "richtext",
  load: () => import("./RichTextEditor"),
};
export default view;
