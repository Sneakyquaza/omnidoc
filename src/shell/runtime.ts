import { create } from "zustand";
import type { EditorCommand, StatusItem } from "../editors/types";

/** État d'exécution par onglet fourni par les éditeurs (commandes, barre d'état, sérialiseur). */
interface RuntimeState {
  commands: Record<string, EditorCommand[]>;
  status: Record<string, StatusItem[]>;
  /** État d'édition déclaré par l'éditeur (absent = `tab.readOnly` fait foi). */
  editable: Record<string, boolean>;
  setCommands(tabId: string, cmds: EditorCommand[]): void;
  setStatus(tabId: string, items: StatusItem[]): void;
  setEditable(tabId: string, editable: boolean): void;
}

export const useRuntime = create<RuntimeState>((set) => ({
  commands: {},
  status: {},
  editable: {},
  setCommands: (tabId, cmds) => set((s) => ({ commands: { ...s.commands, [tabId]: cmds } })),
  setStatus: (tabId, items) => set((s) => ({ status: { ...s.status, [tabId]: items } })),
  setEditable: (tabId, editable) =>
    set((s) =>
      s.editable[tabId] === editable ? s : { editable: { ...s.editable, [tabId]: editable } },
    ),
}));

/** `forSave` : enregistrement interactif (l'éditeur peut poser une question, ou lever `SaveCancelled`). */
export interface SerializeOptions {
  forSave?: boolean;
}

type Serializer = (opts?: SerializeOptions) => unknown;

/** Levée par un sérialiseur quand l'utilisateur annule l'enregistrement. */
export class SaveCancelled extends Error {}

const serializers = new Map<string, Serializer>();

export function registerSerializer(tabId: string, fn: Serializer): void {
  serializers.set(tabId, fn);
}

export function getSerializer(tabId: string): Serializer | undefined {
  return serializers.get(tabId);
}

export interface SaveHandler {
  save?: () => Promise<boolean>;
  saveAs?: () => Promise<boolean>;
}

const saveHandlers = new Map<string, SaveHandler>();

export function registerSaveHandler(tabId: string, handler: SaveHandler | null): void {
  if (handler) saveHandlers.set(tabId, handler);
  else saveHandlers.delete(tabId);
}

export function getSaveHandler(tabId: string): SaveHandler | undefined {
  return saveHandlers.get(tabId);
}

/** Oublie tout ce qu'un onglet a enregistré (fermeture ou rechargement). */
export function clearTabRuntime(tabId: string): void {
  serializers.delete(tabId);
  saveHandlers.delete(tabId);
  useRuntime.setState((s) => {
    const commands = { ...s.commands };
    const status = { ...s.status };
    const editable = { ...s.editable };
    delete commands[tabId];
    delete status[tabId];
    delete editable[tabId];
    return { commands, status, editable };
  });
}
