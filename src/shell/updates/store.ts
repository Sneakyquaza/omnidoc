import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import i18n from "../../i18n";
import { useSettings } from "../../stores/settings";
import { useUi } from "../../stores/ui";
import { pushToast } from "../ui/toastStore";
import { CHANGELOG, parseChangelog, sectionsBetween, sectionsToMarkdown } from "./changelog";
import { shouldAskConsent, shouldAutoCheck, shouldShowUpdate, shouldShowWhatsNew } from "./decide";

export const RELEASES_URL = "https://github.com/Sneakyquaza/omnidoc/releases/latest";

const E2E = Boolean(import.meta.env.VITE_E2E);
const AUTO_CHECK_DELAY_MS = 5000;

export type CheckResult =
  | { status: "upToDate" }
  | { status: "available"; update: Update }
  | { status: "error"; message: string };

interface NotesRequest {
  /** Clé i18n (`updates:notes.*`) du titre. */
  titleKey: "whatsNew" | "changelog";
  version?: string;
  markdown: string;
}

interface UpdatesState {
  /** Mise à jour proposée (dialogue ouvert tant que non nul). */
  update: Update | null;
  currentVersion: string;
  /** Demande de consentement à la vérification automatique en attente. */
  consentPending: boolean;
  notes: NotesRequest | null;
  setUpdate(update: Update | null): void;
  setConsentPending(pending: boolean): void;
  setNotes(notes: NotesRequest | null): void;
}

export const useUpdates = create<UpdatesState>((set) => ({
  update: null,
  currentVersion: "",
  consentPending: false,
  notes: null,
  setUpdate: (update) => set({ update }),
  setConsentPending: (consentPending) => set({ consentPending }),
  setNotes: (notes) => set({ notes }),
}));

/** Interroge le point de mise à jour (réseau : toujours déclenché par un consentement ou une action). */
export async function checkNow(): Promise<CheckResult> {
  try {
    const update = await check();
    return update ? { status: "available", update } : { status: "upToDate" };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

async function currentVersion(): Promise<string> {
  const known = useUpdates.getState().currentVersion;
  if (known) return known;
  const version = await getVersion();
  useUpdates.setState({ currentVersion: version });
  return version;
}

/** Vérification demandée par l'utilisateur ; ouvre le dialogue si une version est disponible. */
export async function checkManually(): Promise<CheckResult> {
  const result = await checkNow();
  if (result.status === "available") {
    useUi.getState().setSettingsOpen(false);
    useUpdates.getState().setUpdate(result.update);
  }
  return result;
}

/** Vérification depuis la palette : le résultat négatif est annoncé par un toast. */
export async function checkWithToast(): Promise<void> {
  pushToast({ kind: "info", text: i18n.t("updates:check.checking") });
  const result = await checkManually();
  if (result.status === "upToDate") {
    pushToast({ kind: "success", text: i18n.t("updates:check.upToDate") });
  } else if (result.status === "error") {
    pushToast({
      kind: "error",
      text: i18n.t("updates:check.error"),
      detail: result.message,
    });
  }
}

export function showFullChangelog(): void {
  useUi.getState().setSettingsOpen(false);
  useUpdates.getState().setNotes({ titleKey: "changelog", markdown: CHANGELOG });
}

/** Démarrage : nouveautés, demande de consentement, vérification silencieuse différée. */
export async function runStartupChecks(): Promise<void> {
  const settings = useSettings.getState();
  let current: string;
  try {
    current = await currentVersion();
  } catch {
    return; // hors Tauri
  }
  if (E2E) return;

  if (shouldShowWhatsNew(settings.lastSeenVersion, current, E2E)) {
    const sections = sectionsBetween(
      parseChangelog(CHANGELOG),
      settings.lastSeenVersion ?? current,
      current,
    );
    if (sections.length > 0) {
      useUpdates
        .getState()
        .setNotes({
          titleKey: "whatsNew",
          version: current,
          markdown: sectionsToMarkdown(sections),
        });
    }
  }
  if (settings.lastSeenVersion !== current) settings.setLastSeenVersion(current);

  if (shouldAskConsent(settings.autoCheckUpdates, E2E)) {
    useUpdates.getState().setConsentPending(true);
  } else if (shouldAutoCheck(settings.autoCheckUpdates, E2E)) {
    setTimeout(() => void silentCheck(current), AUTO_CHECK_DELAY_MS);
  }
}

async function silentCheck(current: string): Promise<void> {
  const result = await checkNow();
  if (result.status !== "available") return;
  const ignored = useSettings.getState().ignoredUpdateVersion;
  if (shouldShowUpdate({ current, available: result.update.version, ignored, auto: true })) {
    useUpdates.getState().setUpdate(result.update);
  }
}

/** Réponse au bandeau de consentement. */
export function answerConsent(accept: boolean): void {
  useSettings.getState().setAutoCheckUpdates(accept);
  useUpdates.getState().setConsentPending(false);
  if (accept)
    void currentVersion()
      .then(silentCheck)
      .catch(() => undefined);
}
