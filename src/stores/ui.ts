import { create } from "zustand";

interface UiState {
  paletteOpen: boolean;
  /** Un glisser-déposer de fichiers survole la fenêtre. */
  dragging: boolean;
  settingsOpen: boolean;
  /** Onglet dont le dialogue « Exporter vers… » est ouvert. */
  exportTabId: string | null;
  setPaletteOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  setExportTabId(id: string | null): void;
  setDragging(dragging: boolean): void;
}

export const useUi = create<UiState>((set) => ({
  paletteOpen: false,
  dragging: false,
  settingsOpen: false,
  exportTabId: null,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setExportTabId: (exportTabId) => set({ exportTabId }),
  setDragging: (dragging) => set({ dragging }),
}));
