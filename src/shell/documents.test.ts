import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openDocument: vi.fn(),
  saveDocument: vi.fn(),
  recoveryStore: vi.fn(),
  recoveryDiscard: vi.fn(),
  detectFile: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../ipc/bindings", () => ({
  commands: {
    ...mocks,
    listHandlers: vi.fn().mockResolvedValue([]),
    watchFile: vi.fn().mockResolvedValue(undefined),
    unwatchFile: vi.fn().mockResolvedValue(undefined),
  },
}));

import { useTabs } from "../stores/tabs";
import type { NewTab } from "../stores/tabs";
import { registerSerializer } from "./runtime";
import { autosaveDirtyTabs, openPath, restoreRecovery, saveTab } from "./documents";

const model = { kind: "binary", size: 1 } as const;

function opened(path: string) {
  return {
    path,
    handlerId: "binary",
    model,
    capabilities: { write: true, fidelity: "full" },
    detected: { handlerId: "binary", labelKey: "x" },
    docId: `doc-${path}`,
    warnings: [],
  };
}

function newTab(path: string | null, extra: Partial<NewTab> = {}): NewTab {
  return {
    path,
    title: "t",
    handlerId: "binary",
    modelKind: "binary",
    readOnly: false,
    docId: `doc-${path}`,
    model,
    capabilities: { write: true, fidelity: "full" } as never,
    ...extra,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("documents", () => {
  beforeEach(() => {
    useTabs.setState({ tabs: [], activeId: null, untitledCount: 0 });
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.recoveryStore.mockResolvedValue(undefined);
    mocks.recoveryDiscard.mockResolvedValue(undefined);
    mocks.saveDocument.mockResolvedValue(undefined);
  });

  it("dédoublonne les ouvertures concurrentes d'un même chemin", async () => {
    mocks.openDocument.mockImplementation(async (p: string) => {
      await flush();
      return opened(p);
    });
    await Promise.all([openPath("/a"), openPath("/a"), openPath("/a")]);
    expect(mocks.openDocument).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().tabs).toHaveLength(1);
  });

  it("saveTab : une modification pendant l'écriture laisse l'onglet modifié", async () => {
    const id = useTabs.getState().openTab(newTab("/a", { dirty: true }));
    useTabs.getState().setDirty(id, true);
    mocks.saveDocument.mockImplementation(async () => {
      await flush();
      useTabs.getState().setDirty(id, true); // frappe pendant l'await
    });
    expect(await saveTab(id)).toBe(true);
    expect(useTabs.getState().tabs[0]?.dirty).toBe(true);
    expect(mocks.recoveryDiscard).not.toHaveBeenCalled();
  });

  it("saveTab : sans modification concurrente l'onglet redevient propre", async () => {
    const id = useTabs.getState().openTab(newTab("/a", { dirty: true }));
    useTabs.getState().setDirty(id, true);
    expect(await saveTab(id)).toBe(true);
    expect(useTabs.getState().tabs[0]?.dirty).toBe(false);
    expect(mocks.recoveryDiscard).toHaveBeenCalledWith("doc-/a");
  });

  it("autosave : pas d'entrée recréée si l'onglet est sauvé pendant la sérialisation", async () => {
    const id = useTabs.getState().openTab(newTab("/a", { dirty: true }));
    registerSerializer(id, async () => {
      await flush();
      useTabs.getState().setDirty(id, false);
      return model;
    });
    await autosaveDirtyTabs();
    expect(mocks.recoveryStore).not.toHaveBeenCalled();
  });

  it("autosave : l'entrée recréée est retirée si l'onglet est fermé pendant l'écriture", async () => {
    const id = useTabs.getState().openTab(newTab("/b", { dirty: true }));
    mocks.recoveryStore.mockImplementation(async () => {
      useTabs.getState().closeTab(id);
    });
    await autosaveDirtyTabs();
    expect(mocks.recoveryDiscard).toHaveBeenCalledWith("doc-/b");
  });

  it("restoreRecovery : un onglet déjà ouvert reçoit le modèle récupéré", async () => {
    const id = useTabs.getState().openTab(newTab("/a"));
    mocks.detectFile.mockResolvedValue({ handlerId: "binary", labelKey: "x" });
    const recovered = { kind: "binary", size: 99 } as const;
    await restoreRecovery([{ docId: "old", path: "/a", model: recovered } as never]);
    const tab = useTabs.getState().tabs.find((x) => x.id === id);
    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(tab?.model).toEqual(recovered);
    expect(tab?.dirty).toBe(true);
    expect(mocks.recoveryDiscard).toHaveBeenCalledWith("old");
  });
});
