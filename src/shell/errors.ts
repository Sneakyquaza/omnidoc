import i18n from "../i18n";
import { pushToast } from "./ui/toastStore";

function isPayload(e: unknown): e is { code: string; message: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { code?: unknown }).code === "string" &&
    typeof (e as { message?: unknown }).message === "string"
  );
}

/** Texte traduit (`errors.<code>`) + détail technique. */
export function describeError(e: unknown): { text: string; detail?: string } {
  if (isPayload(e)) {
    return {
      text: i18n.t(`errors.${e.code}`, { defaultValue: i18n.t("errors.unknown") }),
      detail: e.message,
    };
  }
  if (e instanceof Error) return { text: i18n.t("errors.unknown"), detail: e.message };
  return { text: i18n.t("errors.unknown"), detail: typeof e === "string" ? e : undefined };
}

export function reportError(e: unknown): void {
  const { text, detail } = describeError(e);
  pushToast({ kind: "error", text, detail });
}
