import { describe, expect, it } from "vitest";
import {
  applyShortcutOverrides,
  eventToShortcut,
  findByShortcut,
  findShortcutConflicts,
  formatShortcut,
  isNativeEditShortcut,
  matchesShortcut,
  parseShortcut,
} from "./shortcuts";

const ev = (
  key: string,
  mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey", boolean>> = {},
) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("raccourcis", () => {
  it("analyse la notation", () => {
    expect(parseShortcut("Mod+Shift+S")).toEqual({ mod: true, shift: true, alt: false, key: "s" });
    expect(parseShortcut("Ctrl+Tab")).toEqual({ mod: true, shift: false, alt: false, key: "tab" });
    expect(parseShortcut("Alt+ArrowLeft")).toMatchObject({
      alt: true,
      mod: false,
      key: "arrowleft",
    });
    expect(parseShortcut("Mod++")).toMatchObject({ mod: true, key: "+" });
  });

  it("compare avec l'événement (Ctrl ou Cmd)", () => {
    const p = parseShortcut("Mod+Shift+S");
    expect(matchesShortcut(p, ev("S", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesShortcut(p, ev("s", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(matchesShortcut(p, ev("s", { ctrlKey: true }))).toBe(false);
    expect(matchesShortcut(parseShortcut("Mod+S"), ev("s", { ctrlKey: true, altKey: true }))).toBe(
      false,
    );
  });

  it("Alt + lettre : repli sur e.code (caractère composé)", () => {
    const p = parseShortcut("Mod+Alt+C");
    const e = { ...ev("ç", { ctrlKey: true, altKey: true }), code: "KeyC" };
    expect(matchesShortcut(p, e)).toBe(true);
    expect(matchesShortcut(p, { ...e, code: "KeyV" })).toBe(false);
    // Sans Alt, e.code n'est pas consulté.
    const noAlt = { ...ev("ç", { ctrlKey: true }), code: "KeyC" };
    expect(matchesShortcut(parseShortcut("Mod+C"), noAlt)).toBe(false);
  });

  it("trouve une commande par raccourci", () => {
    const items = [{ id: "a", shortcut: "Mod+O" }, { id: "b" }, { id: "c", shortcut: "Mod+K" }];
    expect(findByShortcut(items, ev("k", { ctrlKey: true }))?.id).toBe("c");
    expect(findByShortcut(items, ev("x", { ctrlKey: true }))).toBeUndefined();
  });

  it("formate pour l'affichage", () => {
    expect(formatShortcut("Mod+Shift+P", false)).toBe("Ctrl+Shift+P");
    expect(formatShortcut("Mod+Shift+P", true)).toBe("⌘⇧P");
    expect(formatShortcut("Ctrl+Tab", false)).toBe("Ctrl+Tab");
  });
});

describe("raccourcis configurables", () => {
  it("applique les surcharges et retire les raccourcis vides", () => {
    const items = [{ id: "a", shortcut: "Mod+A" }, { id: "b", shortcut: "Mod+B" }, { id: "c" }];
    const out = applyShortcutOverrides(items, { a: "Mod+Shift+X", b: "", c: "F5" });
    expect(out.map((i) => i.shortcut)).toEqual(["Mod+Shift+X", undefined, "F5"]);
  });

  it("capture un événement en notation canonique", () => {
    expect(eventToShortcut(ev("s", { ctrlKey: true, shiftKey: true }))).toBe("Mod+Shift+S");
    expect(eventToShortcut(ev("F5"))).toBe("F5");
    expect(eventToShortcut(ev("Control", { ctrlKey: true }))).toBeNull();
    expect(eventToShortcut(ev("a"))).toBeNull();
    expect(eventToShortcut(ev(",", { metaKey: true }))).toBe("Mod+,");
  });

  it("détecte les conflits", () => {
    const items = [
      { id: "a", shortcut: "Mod+S" },
      { id: "b", shortcut: "Mod+Shift+S" },
      { id: "c" },
    ];
    expect(findShortcutConflicts(items, "c", "ctrl+s")).toEqual(["a"]);
    expect(findShortcutConflicts(items, "a", "Mod+S")).toEqual([]);
  });
});

describe("raccourcis natifs de saisie", () => {
  it("reconnaît les raccourcis d edition", () => {
    expect(isNativeEditShortcut(ev("z", { ctrlKey: true }))).toBe(true);
    expect(isNativeEditShortcut(ev("Z", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isNativeEditShortcut(ev("s", { ctrlKey: true }))).toBe(false);
    expect(isNativeEditShortcut(ev("z"))).toBe(false);
  });
});
