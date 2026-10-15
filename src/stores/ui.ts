import { create } from "zustand";

interface UiState {
  paletteOpen: boolean;
  /** Un glisser-déposer de fichiers survole la fenêtre. */
  dragging: boolean;
  setPaletteOpen(open: boolean): void;
  setDragging(dragging: boolean): void;
}

export const useUi = create<UiState>((set) => ({
  paletteOpen: false,
  dragging: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setDragging: (dragging) => set({ dragging }),
}));
