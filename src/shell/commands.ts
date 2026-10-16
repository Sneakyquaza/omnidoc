import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { EditorCommand } from "../editors/types";
import { useSettings } from "../stores/settings";
import { useTabs } from "../stores/tabs";
import { useUi } from "../stores/ui";
import { closeTabWithConfirm, exportTab, openWithDialog, saveTab, saveTabAs } from "./documents";
import { useRuntime } from "./runtime";
import { applyShortcutOverrides } from "./shortcuts";
import { checkWithToast, showFullChangelog } from "./updates/store";

/** Commande du shell ; `hidden` = raccourci seulement (absente de la palette). */
export interface ShellCommand extends EditorCommand {
  hidden?: boolean;
}

function activeId(): string | null {
  return useTabs.getState().activeId;
}

export function buildGlobalCommands(t: TFunction): ShellCommand[] {
  const withTab = (fn: (id: string) => void) => () => {
    const id = activeId();
    if (id) fn(id);
  };
  const openPalette = () => useUi.getState().setPaletteOpen(true);
  return [
    {
      id: "file.open",
      title: t("commands.open"),
      shortcut: "Mod+O",
      run: () => void openWithDialog(),
    },
    {
      id: "file.save",
      title: t("commands.save"),
      shortcut: "Mod+S",
      run: withTab((id) => void saveTab(id)),
    },
    {
      id: "file.saveAs",
      title: t("commands.saveAs"),
      shortcut: "Mod+Shift+S",
      run: withTab((id) => void saveTabAs(id)),
    },
    { id: "file.export", title: t("commands.export"), run: withTab((id) => exportTab(id)) },
    {
      id: "tab.close",
      title: t("commands.closeTab"),
      shortcut: "Mod+W",
      run: withTab((id) => void closeTabWithConfirm(id)),
    },
    {
      id: "tab.next",
      title: t("commands.nextTab"),
      shortcut: "Ctrl+Tab",
      run: () => useTabs.getState().cycleTab(1),
    },
    {
      id: "tab.prev",
      title: t("commands.prevTab"),
      shortcut: "Ctrl+Shift+Tab",
      run: () => useTabs.getState().cycleTab(-1),
    },
    {
      id: "view.sidePanel",
      title: t("commands.toggleSidePanel"),
      shortcut: "Mod+J",
      run: () => useSettings.getState().toggleSidePanel(),
    },
    {
      id: "view.theme",
      title: t("commands.cycleTheme"),
      run: () => useSettings.getState().cycleTheme(),
    },
    {
      id: "view.language",
      title: t("commands.toggleLanguage"),
      run: () => {
        const s = useSettings.getState();
        s.setLanguage(i18nLanguage() === "fr" ? "en" : "fr");
      },
    },
    {
      id: "settings.open",
      title: t("commands.settings"),
      shortcut: "Mod+,",
      run: () => useUi.getState().setSettingsOpen(true),
    },
    {
      id: "app.checkUpdates",
      title: t("commands.checkUpdates"),
      run: () => void checkWithToast(),
    },
    { id: "app.releaseNotes", title: t("commands.releaseNotes"), run: showFullChangelog },
    { id: "palette.open", title: t("commands.palette"), shortcut: "Mod+Shift+P", run: openPalette },
    {
      id: "palette.open2",
      title: t("commands.palette"),
      shortcut: "Mod+K",
      run: openPalette,
      hidden: true,
    },
  ];
}

function i18nLanguage(): string {
  return document.documentElement.lang || "en";
}

/** Commandes actives : celles de l'éditeur de l'onglet actif d'abord, puis les globales. */
export function useShellCommands(): { all: ShellCommand[]; editor: EditorCommand[] } {
  const { t, i18n } = useTranslation();
  const activeTab = useTabs((s) => s.activeId);
  const overrides = useSettings((s) => s.shortcuts);
  const editorCommands = useRuntime((s) => (activeTab ? s.commands[activeTab] : undefined));
  return useMemo(() => {
    const editor = applyShortcutOverrides(editorCommands ?? [], overrides);
    return {
      all: [...editor, ...applyShortcutOverrides(buildGlobalCommands(t), overrides)],
      editor,
    };
    // i18n.language : recalcul des titres au changement de langue
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorCommands, overrides, t, i18n.language]);
}
