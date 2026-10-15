import type { ModelKind } from "../ipc/bindings";
import type { AnyEditorView } from "./types";

/**
 * Seul endroit qui assemble les éditeurs : chaque éditeur déclare sa vue dans
 * `src/editors/<nom>/view.ts` (`export default { kind, namespace, load }`),
 * découverte automatiquement ici.
 */
const modules = import.meta.glob<{ default: AnyEditorView }>("./*/view.ts", { eager: true });

export const editors: Partial<Record<ModelKind, AnyEditorView>> = {};
for (const mod of Object.values(modules)) {
  editors[mod.default.kind] = mod.default;
}
