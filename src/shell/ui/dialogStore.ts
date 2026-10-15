import { create } from "zustand";
import i18n from "../../i18n";

export interface DialogAction {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "danger";
}

export interface DialogRequest {
  title: string;
  message?: string;
  actions: DialogAction[];
  resolve(actionId: string | null): void;
}

interface DialogState {
  queue: DialogRequest[];
}

export const useDialogs = create<DialogState>(() => ({ queue: [] }));

/** Affiche un dialogue à actions multiples ; `null` si fermé (Échap). */
export function choose(opts: Omit<DialogRequest, "resolve">): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.setState((s) => ({ queue: [...s.queue, { ...opts, resolve }] }));
  });
}

export function closeDialog(request: DialogRequest, actionId: string | null): void {
  useDialogs.setState((s) => ({ queue: s.queue.filter((r) => r !== request) }));
  request.resolve(actionId);
}

export async function confirm(opts: {
  title: string;
  message?: string;
  confirmLabel: string;
  danger?: boolean;
}): Promise<boolean> {
  const result = await choose({
    title: opts.title,
    message: opts.message,
    actions: [
      { id: "cancel", label: i18n.t("common.cancel"), variant: "secondary" },
      { id: "ok", label: opts.confirmLabel, variant: opts.danger ? "danger" : "primary" },
    ],
  });
  return result === "ok";
}
