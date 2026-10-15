import { create } from "zustand";
import type { EditorCommand, StatusItem } from "../editors/types";

/** État d'exécution par onglet fourni par les éditeurs (commandes, barre d'état, sérialiseur). */
interface RuntimeState {
  commands: Record<string, EditorCommand[]>;
  status: Record<string, StatusItem[]>;
  setCommands(tabId: string, cmds: EditorCommand[]): void;
  setStatus(tabId: string, items: StatusItem[]): void;
}

export const useRuntime = create<RuntimeState>((set) => ({
  commands: {},
  status: {},
  setCommands: (tabId, cmds) => set((s) => ({ commands: { ...s.commands, [tabId]: cmds } })),
  setStatus: (tabId, items) => set((s) => ({ status: { ...s.status, [tabId]: items } })),
}));

type Serializer = () => unknown;

const serializers = new Map<string, Serializer>();

export function registerSerializer(tabId: string, fn: Serializer): void {
  serializers.set(tabId, fn);
}

export function getSerializer(tabId: string): Serializer | undefined {
  return serializers.get(tabId);
}

/** Oublie tout ce qu'un onglet a enregistré (fermeture ou rechargement). */
export function clearTabRuntime(tabId: string): void {
  serializers.delete(tabId);
  useRuntime.setState((s) => {
    const commands = { ...s.commands };
    const status = { ...s.status };
    delete commands[tabId];
    delete status[tabId];
    return { commands, status };
  });
}
