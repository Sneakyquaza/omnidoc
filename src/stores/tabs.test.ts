import { beforeEach, describe, expect, it } from "vitest";
import { useTabs } from "./tabs";
import type { NewTab } from "./tabs";

function tab(path: string | null, title = "t"): NewTab {
  return {
    path,
    title,
    handlerId: "binary",
    modelKind: "binary",
    readOnly: true,
    docId: `doc-${title}`,
    model: { kind: "binary", size: 1 },
  };
}

describe("store des onglets", () => {
  beforeEach(() => useTabs.setState({ tabs: [], activeId: null, untitledCount: 0 }));

  it("ouvre et active un onglet", () => {
    const id = useTabs.getState().openTab(tab("/a", "a"));
    expect(useTabs.getState().activeId).toBe(id);
    expect(useTabs.getState().tabs).toHaveLength(1);
  });

  it("réactive l'onglet existant pour un même chemin", () => {
    const a = useTabs.getState().openTab(tab("/a", "a"));
    useTabs.getState().openTab(tab("/b", "b"));
    expect(useTabs.getState().openTab(tab("/a", "a"))).toBe(a);
    expect(useTabs.getState().tabs).toHaveLength(2);
    expect(useTabs.getState().activeId).toBe(a);
  });

  it("autorise plusieurs onglets sans chemin", () => {
    useTabs.getState().openTab(tab(null, "u1"));
    useTabs.getState().openTab(tab(null, "u2"));
    expect(useTabs.getState().tabs).toHaveLength(2);
    expect(useTabs.getState().nextUntitled()).toBe(1);
    expect(useTabs.getState().nextUntitled()).toBe(2);
  });

  it("ferme l'onglet actif et active le voisin", () => {
    const { openTab, closeTab } = useTabs.getState();
    const a = openTab(tab("/a", "a"));
    const b = openTab(tab("/b", "b"));
    const c = openTab(tab("/c", "c"));
    useTabs.getState().activateTab(b);
    closeTab(b);
    expect(useTabs.getState().activeId).toBe(c);
    closeTab(c);
    expect(useTabs.getState().activeId).toBe(a);
    closeTab(a);
    expect(useTabs.getState().activeId).toBeNull();
  });

  it("gère l'état modifié", () => {
    const id = useTabs.getState().openTab(tab("/a", "a"));
    useTabs.getState().setDirty(id, true);
    expect(useTabs.getState().tabs[0]?.dirty).toBe(true);
    useTabs.getState().setDirty(id, false);
    expect(useTabs.getState().tabs[0]?.dirty).toBe(false);
  });

  it("réordonne et fait défiler les onglets", () => {
    const { openTab } = useTabs.getState();
    const a = openTab(tab("/a", "a"));
    const b = openTab(tab("/b", "b"));
    const c = openTab(tab("/c", "c"));
    useTabs.getState().moveTab(c, 0);
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([c, a, b]);
    useTabs.getState().activateTab(b);
    useTabs.getState().cycleTab(1);
    expect(useTabs.getState().activeId).toBe(c);
    useTabs.getState().cycleTab(-1);
    expect(useTabs.getState().activeId).toBe(b);
  });

  it("recharge un onglet : remontage et bannière effacée", () => {
    const id = useTabs.getState().openTab(tab("/a", "a"));
    useTabs.getState().patchTab(id, { externalChange: true });
    useTabs.getState().reloadTab(id, { dirty: false });
    const t = useTabs.getState().tabs[0];
    expect(t?.reloadCount).toBe(1);
    expect(t?.externalChange).toBe(false);
  });
});
