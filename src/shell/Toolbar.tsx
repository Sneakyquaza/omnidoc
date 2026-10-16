import { useTranslation } from "react-i18next";
import { useSettings } from "../stores/settings";
import { useTabs } from "../stores/tabs";
import { useUi } from "../stores/ui";
import {
  exportTab,
  openWithDialog,
  reopenTabAs,
  saveTab,
  saveTabAs,
  handlerLabel,
} from "./documents";
import { useHandlers } from "./handlers";
import { Button, IconButton } from "./ui/Button";
import { Menu } from "./ui/Menu";
import { ToolBar, ToolGroup } from "./ui/ToolBar";
import type { MenuItem } from "./ui/Menu";
import styles from "./Toolbar.module.css";

const THEME_ICON = { light: "sun", dark: "moon", system: "system" } as const;

export function Toolbar() {
  const { t } = useTranslation();
  const handlers = useHandlers();
  const tab = useTabs((s) => s.tabs.find((x) => x.id === s.activeId));
  const theme = useSettings((s) => s.theme);
  const sidePanelOpen = useSettings((s) => s.sidePanelOpen);
  const toggleSidePanel = useSettings((s) => s.toggleSidePanel);
  const cycleTheme = useSettings((s) => s.cycleTheme);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);

  const openAsItems: MenuItem[] = [];
  if (tab) {
    const alternatives = tab.detected?.alternatives ?? [];
    const labelOf = (id: string) => {
      const h = handlers.find((x) => x.id === id);
      return h ? handlerLabel(h) : id;
    };
    if (alternatives.length > 0) {
      openAsItems.push({ id: "h-alt", label: t("openAs.suggested"), heading: true });
      for (const id of alternatives) {
        openAsItems.push({
          id: `alt-${id}`,
          label: labelOf(id),
          onSelect: () => void reopenTabAs(tab.id, id),
        });
      }
      openAsItems.push({ id: "sep", label: "", separator: true });
    }
    openAsItems.push({ id: "h-all", label: t("openAs.all"), heading: true });
    for (const h of handlers) {
      openAsItems.push({
        id: `all-${h.id}`,
        label: handlerLabel(h),
        disabled: h.id === tab.handlerId,
        onSelect: () => void reopenTabAs(tab.id, h.id),
      });
    }
  }

  return (
    <div className={styles.toolbar}>
      <ToolBar label={t("toolbar.label")}>
        <ToolGroup>
          <Button variant="ghost" icon="open" onClick={() => void openWithDialog()}>
            {t("toolbar.open")}
          </Button>
          <Button
            variant="ghost"
            icon="save"
            disabled={!tab}
            onClick={() => tab && void saveTab(tab.id)}
          >
            {t("toolbar.save")}
          </Button>
          <Button
            variant="ghost"
            icon="saveAs"
            disabled={!tab}
            onClick={() => tab && void saveTabAs(tab.id)}
          >
            {t("toolbar.saveAs")}
          </Button>
        </ToolGroup>
        <ToolGroup>
          <Button
            variant="ghost"
            icon="export"
            disabled={!tab}
            onClick={() => tab && exportTab(tab.id)}
          >
            {t("toolbar.export")}
          </Button>
          <Menu
            label={t("toolbar.openAs")}
            icon="openAs"
            items={openAsItems}
            disabled={!tab?.path}
          />
        </ToolGroup>
        <span className={styles.spacer} />
        <ToolGroup>
          <IconButton
            icon="panel"
            label={t("toolbar.sidePanel")}
            pressed={sidePanelOpen}
            onClick={toggleSidePanel}
          />
          <IconButton
            icon={THEME_ICON[theme]}
            label={t("toolbar.theme", { theme: t(`theme.${theme}`) })}
            onClick={cycleTheme}
          />
          <IconButton
            icon="command"
            label={t("toolbar.palette")}
            onClick={() => setPaletteOpen(true)}
          />
        </ToolGroup>
      </ToolBar>
    </div>
  );
}
