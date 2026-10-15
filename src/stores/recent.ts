import { create } from "zustand";
import { loadJson, saveJson } from "./persist";

export const MAX_RECENT = 20;
const KEY = "omnidoc.recent";

interface RecentState {
  paths: string[];
  add(path: string): void;
  remove(path: string): void;
  clear(): void;
}

function load(): string[] {
  const raw = loadJson<unknown>(KEY, []);
  return Array.isArray(raw)
    ? raw.filter((p): p is string => typeof p === "string").slice(0, MAX_RECENT)
    : [];
}

export const useRecent = create<RecentState>((set) => ({
  paths: load(),
  add: (path) =>
    set((s) => ({ paths: [path, ...s.paths.filter((p) => p !== path)].slice(0, MAX_RECENT) })),
  remove: (path) => set((s) => ({ paths: s.paths.filter((p) => p !== path) })),
  clear: () => set({ paths: [] }),
}));

useRecent.subscribe((s) => saveJson(KEY, s.paths));
