import { create } from "zustand";
import { loadJson, saveJson } from "./persist";

export type Theme = "light" | "dark" | "system";
export type Language = "fr" | "en" | "auto";

interface Persisted {
  theme: Theme;
  language: Language;
  sidePanelOpen: boolean;
}

interface SettingsState extends Persisted {
  setTheme(theme: Theme): void;
  cycleTheme(): void;
  setLanguage(language: Language): void;
  toggleSidePanel(): void;
}

const KEY = "omnidoc.settings";
const THEMES: Theme[] = ["system", "light", "dark"];
const DEFAULTS: Persisted = { theme: "system", language: "auto", sidePanelOpen: true };

function load(): Persisted {
  const raw = loadJson<Partial<Persisted>>(KEY, {});
  return {
    theme: THEMES.includes(raw.theme as Theme) ? (raw.theme as Theme) : DEFAULTS.theme,
    language: ["fr", "en", "auto"].includes(raw.language as string)
      ? (raw.language as Language)
      : DEFAULTS.language,
    sidePanelOpen:
      typeof raw.sidePanelOpen === "boolean" ? raw.sidePanelOpen : DEFAULTS.sidePanelOpen,
  };
}

export const useSettings = create<SettingsState>((set) => ({
  ...load(),
  setTheme: (theme) => set({ theme }),
  cycleTheme: () =>
    set((s) => ({ theme: THEMES[(THEMES.indexOf(s.theme) + 1) % THEMES.length] ?? "system" })),
  setLanguage: (language) => set({ language }),
  toggleSidePanel: () => set((s) => ({ sidePanelOpen: !s.sidePanelOpen })),
}));

useSettings.subscribe((s) =>
  saveJson(KEY, { theme: s.theme, language: s.language, sidePanelOpen: s.sidePanelOpen }),
);
