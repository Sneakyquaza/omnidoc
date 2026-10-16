import { create } from "zustand";
import { loadJson, saveJson } from "./persist";

export type Theme = "light" | "dark" | "system";
export type Language = "fr" | "en" | "auto";

/** Intervalles d'autosave proposés, en secondes (0 = désactivé). */
export const AUTOSAVE_CHOICES = [0, 15, 30, 60, 120] as const;
export const UI_SCALE_MIN = 90;
export const UI_SCALE_MAX = 130;
export const EDITOR_FONT_SIZE_MIN = 9;
export const EDITOR_FONT_SIZE_MAX = 32;

interface Persisted {
  theme: Theme;
  language: Language;
  sidePanelOpen: boolean;
  /** Intervalle d'autosave de récupération en secondes (0 = désactivé). */
  autosaveSeconds: number;
  /** Demander confirmation avant d'enregistrer dans un format à fidélité partielle. */
  confirmPartialSave: boolean;
  /** Taille de police de l'interface, en pourcentage. */
  uiScale: number;
  /** Police des éditeurs de code (vide = monospace par défaut). */
  editorFontFamily: string;
  editorFontSize: number;
  /** Surcharges de raccourcis par id de commande (chaîne vide = raccourci retiré). */
  shortcuts: Record<string, string>;
}

interface SettingsState extends Persisted {
  setTheme(theme: Theme): void;
  cycleTheme(): void;
  setLanguage(language: Language): void;
  toggleSidePanel(): void;
  setAutosaveSeconds(seconds: number): void;
  setConfirmPartialSave(on: boolean): void;
  setUiScale(percent: number): void;
  setEditorFontFamily(family: string): void;
  setEditorFontSize(size: number): void;
  setShortcut(id: string, shortcut: string): void;
  resetShortcut(id: string): void;
  resetShortcuts(): void;
}

const KEY = "omnidoc.settings";
const THEMES: Theme[] = ["system", "light", "dark"];
const DEFAULTS: Persisted = {
  theme: "system",
  language: "auto",
  sidePanelOpen: true,
  autosaveSeconds: 30,
  confirmPartialSave: true,
  uiScale: 100,
  editorFontFamily: "",
  editorFontSize: 13,
  shortcuts: {},
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function loadShortcuts(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

function load(): Persisted {
  const raw = loadJson<Partial<Persisted>>(KEY, {});
  return {
    theme: THEMES.includes(raw.theme as Theme) ? (raw.theme as Theme) : DEFAULTS.theme,
    language: ["fr", "en", "auto"].includes(raw.language as string)
      ? (raw.language as Language)
      : DEFAULTS.language,
    sidePanelOpen:
      typeof raw.sidePanelOpen === "boolean" ? raw.sidePanelOpen : DEFAULTS.sidePanelOpen,
    autosaveSeconds: (AUTOSAVE_CHOICES as readonly number[]).includes(raw.autosaveSeconds as number)
      ? (raw.autosaveSeconds as number)
      : DEFAULTS.autosaveSeconds,
    confirmPartialSave:
      typeof raw.confirmPartialSave === "boolean"
        ? raw.confirmPartialSave
        : DEFAULTS.confirmPartialSave,
    uiScale: clamp(raw.uiScale, UI_SCALE_MIN, UI_SCALE_MAX, DEFAULTS.uiScale),
    editorFontFamily:
      typeof raw.editorFontFamily === "string" ? raw.editorFontFamily : DEFAULTS.editorFontFamily,
    editorFontSize: clamp(
      raw.editorFontSize,
      EDITOR_FONT_SIZE_MIN,
      EDITOR_FONT_SIZE_MAX,
      DEFAULTS.editorFontSize,
    ),
    shortcuts: loadShortcuts(raw.shortcuts),
  };
}

export const useSettings = create<SettingsState>((set) => ({
  ...load(),
  setTheme: (theme) => set({ theme }),
  cycleTheme: () =>
    set((s) => ({ theme: THEMES[(THEMES.indexOf(s.theme) + 1) % THEMES.length] ?? "system" })),
  setLanguage: (language) => set({ language }),
  toggleSidePanel: () => set((s) => ({ sidePanelOpen: !s.sidePanelOpen })),
  setAutosaveSeconds: (autosaveSeconds) => set({ autosaveSeconds }),
  setConfirmPartialSave: (confirmPartialSave) => set({ confirmPartialSave }),
  setUiScale: (percent) => set({ uiScale: clamp(percent, UI_SCALE_MIN, UI_SCALE_MAX, 100) }),
  setEditorFontFamily: (editorFontFamily) => set({ editorFontFamily }),
  setEditorFontSize: (size) =>
    set({ editorFontSize: clamp(size, EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX, 13) }),
  setShortcut: (id, shortcut) => set((s) => ({ shortcuts: { ...s.shortcuts, [id]: shortcut } })),
  resetShortcut: (id) =>
    set((s) => {
      const rest = { ...s.shortcuts };
      delete rest[id];
      return { shortcuts: rest };
    }),
  resetShortcuts: () => set({ shortcuts: {} }),
}));

useSettings.subscribe((s) =>
  saveJson(KEY, {
    theme: s.theme,
    language: s.language,
    sidePanelOpen: s.sidePanelOpen,
    autosaveSeconds: s.autosaveSeconds,
    confirmPartialSave: s.confirmPartialSave,
    uiScale: s.uiScale,
    editorFontFamily: s.editorFontFamily,
    editorFontSize: s.editorFontSize,
    shortcuts: s.shortcuts,
  } satisfies Persisted),
);
