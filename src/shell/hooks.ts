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
import { findByShortcut, isNativeEditShortcut, isTextEntry } from "./shortcuts";
import { choose, confirm, useDialogs } from "./ui/dialogStore";

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

  const uiScale = useSettings((s) => s.uiScale);
  const editorFontFamily = useSettings((s) => s.editorFontFamily);
  const editorFontSize = useSettings((s) => s.editorFontSize);

  // Taille de l'interface et police des éditeurs (variables CSS utilisables par les éditeurs).
  useEffect(() => {
    const style = document.documentElement.style;
    style.setProperty("--ui-scale", String(uiScale / 100));
    style.setProperty("--editor-font-family", editorFontFamily.trim() || "var(--font-mono)");
    style.setProperty("--editor-font-size", `${editorFontSize}px`);
  }, [uiScale, editorFontFamily, editorFontSize]);

  useEffect(() => {
    const lng = language === "auto" ? detectLanguage() : language;
    document.documentElement.lang = lng;
    if (i18n.language !== lng) void i18n.changeLanguage(lng);
  }, [language]);
}

/** Raccourcis clavier centralisés (commandes de l'éditeur actif prioritaires). */
export function useGlobalShortcuts(): void {
  const { all, editor } = useShellCommands();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (useDialogs.getState().queue.length > 0) return;
      // Les dialogues Paramètres / Exporter gèrent eux-mêmes leur clavier.
      const ui = useUi.getState();
      if (ui.settingsOpen || ui.exportTabId !== null) return;
      const cmd = findByShortcut(all, e);
      if (!cmd) return;
      // Dans un champ de saisie, l'undo/copier-coller natif prime sur les commandes d'éditeur.
      if (editor.includes(cmd) && isNativeEditShortcut(e) && isTextEntry(document.activeElement)) {
        return;
      }
      e.preventDefault();
      cmd.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [all, editor]);
}

/** Autosave de récupération selon l'intervalle des préférences (0 = désactivé). */
export function useAutosave(): void {
  const seconds = useSettings((s) => s.autosaveSeconds);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = setInterval(() => void autosaveDirtyTabs(), seconds * 1000);
    return () => clearInterval(timer);
  }, [seconds]);
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

/** Événements système : fichier modifié, glisser-déposer, fichiers d'une autre instance, fermeture de la fenêtre. */
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

    keep(
      listen<{ paths: string[] }>("open-paths", (e) => {
        void openPaths(e.payload.paths);
      }),
    );

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);
}
