import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import i18n, { detectLanguage } from "../i18n";
import { commands } from "../ipc/bindings";
import { useSettings } from "../stores/settings";
import { useTabs } from "../stores/tabs";
import { useUi } from "../stores/ui";
import { useShellCommands } from "./commands";
import { autosaveDirtyTabs, openPaths, restoreRecovery } from "./documents";
import { findByShortcut } from "./shortcuts";
import { choose, confirm, useDialogs } from "./ui/dialogStore";

export const AUTOSAVE_INTERVAL_MS = 30_000;

/** Applique thème (`data-theme`) et langue. */
export function useAppearance(): void {
  const theme = useSettings((s) => s.theme);
  const language = useSettings((s) => s.language);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && !!media?.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    if (theme !== "system" || !media) return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    const lng = language === "auto" ? detectLanguage() : language;
    document.documentElement.lang = lng;
    if (i18n.language !== lng) void i18n.changeLanguage(lng);
  }, [language]);
}

/** Raccourcis clavier centralisés (commandes de l'éditeur actif prioritaires). */
export function useGlobalShortcuts(): void {
  const { all } = useShellCommands();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (useDialogs.getState().queue.length > 0) return;
      const cmd = findByShortcut(all, e);
      if (!cmd) return;
      e.preventDefault();
      cmd.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [all]);
}

let started = false;

/** Démarrage : fichiers passés en argument, puis proposition de récupération. */
export function useStartup(): void {
  useEffect(() => {
    if (started) return;
    started = true;
    void (async () => {
      try {
        await openPaths(await commands.startupPaths());
        const entries = await commands.recoveryList();
        if (entries.length === 0) return;
        const choice = await choose({
          title: i18n.t("recovery.title"),
          message: i18n.t("recovery.message", { count: entries.length }),
          actions: [
            { id: "ignore", label: i18n.t("recovery.ignore"), variant: "secondary" },
            { id: "restore", label: i18n.t("recovery.restore"), variant: "primary" },
          ],
        });
        if (choice === "restore") {
          await restoreRecovery(entries);
        } else {
          await Promise.all(
            entries.map((e) => commands.recoveryDiscard(e.docId).catch(() => undefined)),
          );
        }
      } catch {
        // hors Tauri (tests, navigateur) : pas de démarrage
      }
    })();
  }, []);
}

/** Événements système : fichier modifié, glisser-déposer, autosave, fermeture de la fenêtre. */
export function useSystemEvents(): void {
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    let disposed = false;
    const keep = (p: Promise<() => void>) =>
      p.then((un) => (disposed ? un() : cleanups.push(un))).catch(() => undefined);

    keep(
      listen<{ path: string }>("file-changed", (e) => {
        const tab = useTabs.getState().tabs.find((t) => t.path === e.payload.path);
        if (tab) useTabs.getState().patchTab(tab.id, { externalChange: true });
      }),
    );

    keep(
      getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") useUi.getState().setDragging(true);
        else if (p.type === "leave") useUi.getState().setDragging(false);
        else if (p.type === "drop") {
          useUi.getState().setDragging(false);
          void openPaths(p.paths);
        }
      }),
    );

    keep(
      getCurrentWindow().onCloseRequested(async (event) => {
        const dirty = useTabs.getState().tabs.filter((t) => t.dirty);
        if (dirty.length === 0) return;
        event.preventDefault();
        const ok = await confirm({
          title: i18n.t("quit.title"),
          message: i18n.t("quit.message", { count: dirty.length }),
          confirmLabel: i18n.t("quit.confirm"),
          danger: true,
        });
        if (ok) {
          await Promise.all(
            dirty.map((t) => commands.recoveryDiscard(t.docId).catch(() => undefined)),
          );
          await getCurrentWindow().destroy();
        }
      }),
    );

    const timer = setInterval(() => void autosaveDirtyTabs(), AUTOSAVE_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
      cleanups.forEach((fn) => fn());
    };
  }, []);
}
