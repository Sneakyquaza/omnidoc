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
