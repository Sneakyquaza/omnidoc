import { useTranslation } from "react-i18next";
import { useSettings } from "../stores/settings";
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
import { SlotTarget, SlotsProvider } from "./slots";
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

  const hasTabs = useTabs((s) => s.tabs.length > 0);
  const active = useTabs((s) => s.tabs.find((x) => x.id === s.activeId));
  const sidePanelOpen = useSettings((s) => s.sidePanelOpen);
  const dragging = useUi((s) => s.dragging);

  return (
    <SlotsProvider>
      <div className={styles.shell}>
        <TabBar />
        <Toolbar />
        <SlotTarget slot="toolbar" className={styles.contextBar} />
        <div className={styles.body}>
          <aside
            className={styles.sidePanel}
            hidden={!sidePanelOpen}
            aria-label={t("shell.sidePanel")}
          >
            <SlotTarget slot="left" />
          </aside>
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
              {!hasTabs && <Welcome />}
            </div>
          </main>
          <aside
            className={styles.sidePanel}
            hidden={!sidePanelOpen}
            aria-label={t("shell.sidePanel")}
          >
            <SlotTarget slot="right" />
          </aside>
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
