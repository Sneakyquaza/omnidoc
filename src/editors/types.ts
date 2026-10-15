import type { ComponentType } from "react";
import type { Capabilities, Detected, ModelKind } from "../ipc/bindings";

/** Vue d'un onglet transmise aux éditeurs (le shell y ajoute des champs internes). */
export interface TabState {
  id: string;
  path: string | null;
  title: string;
  handlerId: string;
  modelKind: ModelKind;
  readOnly: boolean;
  dirty: boolean;
  detected?: Detected;
  capabilities?: Capabilities;
}

/** Élément de la barre d'état. */
export interface StatusItem {
  id: string;
  text: string;
  title?: string;
}

export interface EditorCommand {
  id: string;
  /** Déjà traduit. */
  title: string;
  /** Notation « Mod+B » (Mod = Ctrl ou Cmd). */
  shortcut?: string;
  run(): void;
}

export interface EditorProps<M> {
  tab: TabState;
  /** Sous-modèle initial ; ne change pas pendant la vie de l'éditeur (rechargement = remontage). */
  model: M;
  readOnly: boolean;
  setDirty(dirty: boolean): void;
  /** Appelé par le shell à la sauvegarde / autosave / export. */
  registerSerializer(fn: () => M | Promise<M>): void;
  /** Palette + raccourcis, actifs seulement quand l'onglet est actif. */
  registerCommands(cmds: EditorCommand[]): void;
  setStatus(items: StatusItem[]): void;
}

export interface EditorView<M = unknown> {
  kind: ModelKind;
  /** Namespace i18n (`src/i18n/locales/<lang>/<namespace>.json`). */
  namespace: string;
  load: () => Promise<{ default: ComponentType<EditorProps<M>> }>;
}

/** Type du registre : les composants sont contravariants sur `M`, d'où le `any`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEditorView = EditorView<any>;
