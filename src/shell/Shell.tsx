import { useTranslation } from "react-i18next";
import { useTabs } from "../stores/tabs";
import { useUi } from "../stores/ui";
import { CommandPalette } from "./CommandPalette";
import { EditorHost } from "./EditorHost";
import { ExportDialog } from "./ExportDialog";
import { SettingsDialog } from "./SettingsDialog";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";
import { Toolbar } from "./Toolbar";
import { Welcome } from "./Welcome";
import { ignoreExternalChange, reloadFromDisk } from "./documents";
import {
  useAppearance,
  useAutosave,
  useGlobalShortcuts,
  useStartup,
  useSystemEvents,
} from "./hooks";
import { SidePanelColumn, SlotTarget, SlotsProvider } from "./slots";
import { Button } from "./ui/Button";
import { DialogHost } from "./ui/Dialog";
import { ToastHost } from "./ui/Toast";
import styles from "./Shell.module.css";

export function Shell() {
  const { t } = useTranslation();
  useAppearance();
  useAutosave();
  useGlobalShortcuts();
  useStartup();
  useSystemEvents();

  const active = useTabs((s) => s.tabs.find((x) => x.id === s.activeId));
  const dragging = useUi((s) => s.dragging);

  return (
    <SlotsProvider>
      <div className={styles.shell}>
        <TabBar />
        <Toolbar />
        <SlotTarget slot="toolbar" className={styles.contextBar} />
        <div className={styles.body}>
          <SidePanelColumn
            side="left"
            className={styles.sidePanel}
            label={t("shell.sidePanel")}
          />
          <main className={styles.main}>
            {active?.externalChange && (
              <div className={styles.banner} role="alert">
                <span>{t("banner.externalChange")}</span>
                <Button variant="primary" onClick={() => void reloadFromDisk(active.id)}>
                  {t("banner.reload")}
                </Button>
                <Button onClick={() => ignoreExternalChange(active.id)}>
                  {t("banner.ignore")}
                </Button>
              </div>
            )}
            <div className={styles.editor}>
              <EditorHost />
              {!active && <Welcome />}
            </div>
          </main>
          <SidePanelColumn
            side="right"
            className={styles.sidePanel}
            label={t("shell.sidePanel")}
          />
        </div>
        <StatusBar />
        {dragging && <div className={styles.dropOverlay}>{t("welcome.dropHere")}</div>}
        <CommandPalette />
        <ExportDialog />
        <SettingsDialog />
        <DialogHost />
        <ToastHost />
      </div>
    </SlotsProvider>
  );
}
