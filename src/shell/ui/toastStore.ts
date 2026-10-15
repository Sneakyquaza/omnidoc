import { create } from "zustand";

export interface ToastItem {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
  detail?: string;
}

interface ToastState {
  toasts: ToastItem[];
  dismiss(id: number): void;
}

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

let nextId = 1;

export function pushToast(toast: Omit<ToastItem, "id">): void {
  const id = nextId++;
  useToasts.setState((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
  setTimeout(() => useToasts.getState().dismiss(id), toast.kind === "error" ? 10000 : 5000);
}
