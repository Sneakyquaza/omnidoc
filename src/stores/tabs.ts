import { create } from "zustand";
import type { DocumentModel } from "../ipc/bindings";
import type { TabState } from "../editors/types";

/** Onglet complet côté shell (`TabState` + champs internes). */
export interface TabEntry extends TabState {
  docId: string;
  model: DocumentModel;
  /** Incrémenté à chaque rechargement : l'éditeur est remonté (key = id + reloadCount). */
  reloadCount: number;
  /** Le fichier a changé sur le disque. */
  externalChange: boolean;
  /** Confirmation « fidélité partielle » déjà donnée pour cet onglet. */
  fidelityConfirmed: boolean;
  warnings: string[];
}

export type NewTab = Omit<
  TabEntry,
  "id" | "dirty" | "reloadCount" | "externalChange" | "fidelityConfirmed" | "warnings"
> &
  Partial<Pick<TabEntry, "dirty" | "warnings">>;

interface TabsState {
  tabs: TabEntry[];
  activeId: string | null;
  untitledCount: number;
  /** Ouvre un onglet (ou active celui qui a déjà ce chemin) ; renvoie son id. */
  openTab(tab: NewTab): string;
  closeTab(id: string): void;
  activateTab(id: string): void;
  /** Affiche l'écran d'accueil sans fermer les onglets (aucun onglet actif). */
  showHome(): void;
  moveTab(id: string, toIndex: number): void;
  cycleTab(delta: number): void;
  setDirty(id: string, dirty: boolean): void;
  patchTab(id: string, patch: Partial<TabEntry>): void;
  /** Remplace le contenu d'un onglet et force le remontage de l'éditeur. */
  reloadTab(id: string, patch: Partial<TabEntry>): void;
  nextUntitled(): number;
}

let counter = 0;

function update(tabs: TabEntry[], id: string, fn: (t: TabEntry) => TabEntry): TabEntry[] {
  return tabs.map((t) => (t.id === id ? fn(t) : t));
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  untitledCount: 0,
  openTab: (init) => {
    if (init.path !== null) {
      const existing = get().tabs.find((t) => t.path === init.path);
      if (existing) {
        set({ activeId: existing.id });
        return existing.id;
      }
    }
    const id = `tab-${++counter}`;
    const tab: TabEntry = {
      dirty: false,
      warnings: [],
      ...init,
      id,
      reloadCount: 0,
      externalChange: false,
      fidelityConfirmed: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeId: id }));
    return id;
  },
  closeTab: (id) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id);
      if (index < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeId =
        s.activeId === id ? ((tabs[index] ?? tabs[index - 1])?.id ?? null) : s.activeId;
      return { tabs, activeId };
    }),
  showHome: () => set({ activeId: null }),
  activateTab: (id) => set((s) => (s.tabs.some((t) => t.id === id) ? { activeId: id } : s)),
  moveTab: (id, toIndex) =>
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === id);
      const tab = s.tabs[from];
      if (!tab) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab);
      return { tabs };
    }),
  cycleTab: (delta) =>
    set((s) => {
      if (s.tabs.length === 0) return s;
      const current = s.tabs.findIndex((t) => t.id === s.activeId);
      const next = (current + delta + s.tabs.length) % s.tabs.length;
      return { activeId: s.tabs[next]?.id ?? s.activeId };
    }),
  setDirty: (id, dirty) =>
    set((s) => ({ tabs: update(s.tabs, id, (t) => (t.dirty === dirty ? t : { ...t, dirty })) })),
  patchTab: (id, patch) => set((s) => ({ tabs: update(s.tabs, id, (t) => ({ ...t, ...patch })) })),
  reloadTab: (id, patch) =>
    set((s) => ({
      tabs: update(s.tabs, id, (t) => ({
        ...t,
        ...patch,
        reloadCount: t.reloadCount + 1,
        externalChange: false,
      })),
    })),
  nextUntitled: () => {
    const n = get().untitledCount + 1;
    set({ untitledCount: n });
    return n;
  },
}));
