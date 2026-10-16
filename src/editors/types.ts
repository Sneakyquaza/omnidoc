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

/**
 * Règle du gestionnaire de raccourcis : quand le focus est dans un champ de saisie (input,
 * textarea, contenteditable), les commandes d'ÉDITEUR dont le raccourci est Mod+Z / Mod+Y /
 * Mod+Shift+Z / Mod+A / Mod+C / Mod+V / Mod+X / Mod+D sont ignorées : le comportement natif du
 * champ (undo, copier-coller…) s'applique. Aucune déclaration requise de la part des éditeurs.
 */

export interface EditorProps<M> {
  tab: TabState;
  /** Sous-modèle initial ; ne change pas pendant la vie de l'éditeur (rechargement = remontage). */
  model: M;
  readOnly: boolean;
  /** `false` quand l'onglet est en arrière-plan (l'éditeur reste monté) ; absent = actif. */
  active?: boolean;
  setDirty(dirty: boolean): void;
  /** Appelé par le shell à la sauvegarde / autosave / export. */
  registerSerializer(fn: (opts?: { forSave?: boolean }) => M | Promise<M>): void;
  /** Palette + raccourcis, actifs seulement quand l'onglet est actif. */
  registerCommands(cmds: EditorCommand[]): void;
  setStatus(items: StatusItem[]): void;
  /**
   * Éditeurs à commandes dédiées (handler `write: false` : image, pdf, archive) : prend la main sur
   * Enregistrer / Enregistrer sous (boutons, Mod+S, Mod+Shift+S, fermeture d'un onglet modifié).
   * Chaque fonction renvoie `true` si tout est enregistré ; une fonction absente = sans effet.
   * `null` retire le handler (comportement standard `save_document`). Ces onglets sont exclus de
   * l'autosave de récupération.
   */
  registerSaveHandler(
    handler: { save?: () => Promise<boolean>; saveAs?: () => Promise<boolean> } | null,
  ): void;
  /**
   * État d'édition réel, prioritaire sur `tab.readOnly` pour l'indicateur « Lecture seule »
   * (booléen plutôt qu'une union : seuls deux états existent).
   */
  setEditable(editable: boolean): void;
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
