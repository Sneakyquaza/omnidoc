import { describe, expect, it } from "vitest";
import { findByShortcut, formatShortcut, matchesShortcut, parseShortcut } from "./shortcuts";

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
