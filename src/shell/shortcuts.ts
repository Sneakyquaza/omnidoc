export interface ParsedShortcut {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** Touche en minuscules (`e.key.toLowerCase()`). */
  key: string;
}

type KeyEventLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

const KEY_ALIASES: Record<string, string> = { space: " ", esc: "escape", plus: "+" };

/** Analyse la notation « Mod+Shift+S » (Mod, Ctrl et Cmd sont équivalents). */
export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split("+");
  let key = parts.pop() ?? "";
  if (key === "") {
    // « Mod++ » : la touche est le signe plus
    key = "+";
    parts.pop();
  }
  const mods = parts.map((p) => p.toLowerCase());
  key = key.toLowerCase();
  return {
    mod: mods.some((m) => m === "mod" || m === "ctrl" || m === "cmd" || m === "meta"),
    shift: mods.includes("shift"),
    alt: mods.includes("alt"),
    key: KEY_ALIASES[key] ?? key,
  };
}

export function matchesShortcut(p: ParsedShortcut, e: KeyEventLike): boolean {
  return (
    e.key.toLowerCase() === p.key &&
    (e.ctrlKey || e.metaKey) === p.mod &&
    e.shiftKey === p.shift &&
    e.altKey === p.alt
  );
}

/** Premier élément dont le raccourci correspond à l'événement. */
export function findByShortcut<T extends { shortcut?: string }>(
  items: T[],
  e: KeyEventLike,
): T | undefined {
  return items.find(
    (i) => i.shortcut !== undefined && matchesShortcut(parseShortcut(i.shortcut), e),
  );
}

const NATIVE_EDIT_KEYS = ["z", "y", "a", "c", "v", "x", "d"];

/** Mod+Z/Y/A/C/V/X/D (avec ou sans Shift) : raccourcis que les champs de saisie gèrent nativement. */
export function isNativeEditShortcut(e: KeyEventLike): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && NATIVE_EDIT_KEYS.includes(e.key.toLowerCase());
}

/** `true` si l'élément est un champ de saisie (input texte, textarea, contenteditable). */
export function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "range", "submit", "reset", "file"].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

/** Texte d'affichage (« Ctrl+Shift+S » ou « ⌘⇧S »). */
export function formatShortcut(shortcut: string, mac: boolean = isMac()): string {
  const p = parseShortcut(shortcut);
  const key =
    p.key.length === 1 ? p.key.toUpperCase() : p.key.charAt(0).toUpperCase() + p.key.slice(1);
  if (mac) return `${p.mod ? "⌘" : ""}${p.alt ? "⌥" : ""}${p.shift ? "⇧" : ""}${key}`;
  return [p.mod ? "Ctrl" : "", p.alt ? "Alt" : "", p.shift ? "Shift" : "", key]
    .filter(Boolean)
    .join("+");
}

/** Applique les surcharges de l'utilisateur (par id) ; chaîne vide = raccourci retiré. */
export function applyShortcutOverrides<T extends { id: string; shortcut?: string }>(
  items: T[],
  overrides: Record<string, string>,
): T[] {
  return items.map((item) => {
    const override = overrides[item.id];
    if (override === undefined) return item;
    return { ...item, shortcut: override === "" ? undefined : override };
  });
}

const MODIFIER_KEYS = ["control", "shift", "alt", "meta", "altgraph", "os"];

/** Notation « Mod+Shift+S » d'un événement clavier ; `null` si ce n'est pas un raccourci valide. */
export function eventToShortcut(e: KeyEventLike): string | null {
  const key = e.key;
  if (MODIFIER_KEYS.includes(key.toLowerCase()) || key === "Dead" || key === "Unidentified") {
    return null;
  }
  const mod = e.ctrlKey || e.metaKey;
  // Une lettre seule n'est pas un raccourci : elle servirait à la saisie.
  if (key.length === 1 && key !== " " && !mod && !e.altKey) return null;
  if (key === "Tab" && !mod && !e.altKey) return null;
  const name =
    key === " " ? "Space" : key === "+" ? "Plus" : key.length === 1 ? key.toUpperCase() : key;
  return [mod ? "Mod" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", name]
    .filter(Boolean)
    .join("+");
}

/** Identifiants (autres que `id`) dont le raccourci effectif est identique. */
export function findShortcutConflicts(
  items: Array<{ id: string; shortcut?: string }>,
  id: string,
  shortcut: string,
): string[] {
  const target = parseShortcut(shortcut);
  return items
    .filter((i) => {
      if (i.id === id || i.shortcut === undefined) return false;
      const p = parseShortcut(i.shortcut);
      return (
        p.key === target.key &&
        p.mod === target.mod &&
        p.shift === target.shift &&
        p.alt === target.alt
      );
    })
    .map((i) => i.id);
}
