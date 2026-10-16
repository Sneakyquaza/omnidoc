import { useTranslation } from "react-i18next";
import { IconButton } from "../../shell/ui/Button";
import type { IconName } from "../../shell/ui/icons";
import { ToolBar, ToolGroup } from "../../shell/ui/ToolBar";
import styles from "./SheetEditor.module.css";

export type FormatKind = "general" | "number" | "percent" | "currency" | "date";

interface SheetToolbarProps {
  readOnly: boolean;
  canUndo: boolean;
  canRedo: boolean;
  header: boolean;
  filterOn: boolean;
  onUndo(): void;
  onRedo(): void;
  onFormat(kind: FormatKind): void;
  onDecimals(delta: 1 | -1): void;
  onSort(ascending: boolean): void;
  onToggleHeader(): void;
  onToggleFilter(): void;
}

export function SheetToolbar(p: SheetToolbarProps) {
  const { t } = useTranslation("sheet");
  const btn = (
    label: string,
    icon: IconName,
    onClick: () => void,
    opts?: { pressed?: boolean; disabled?: boolean },
  ) => (
    <IconButton
      icon={icon}
      label={label}
      pressed={opts?.pressed}
      disabled={opts?.disabled ?? p.readOnly}
      onClick={onClick}
    />
  );
  return (
    <div className={styles.toolbar}>
      <ToolBar label={t("toolbar.label")}>
        <ToolGroup>
          {btn(t("toolbar.undo"), "undo", p.onUndo, { disabled: p.readOnly || !p.canUndo })}
          {btn(t("toolbar.redo"), "redo", p.onRedo, { disabled: p.readOnly || !p.canRedo })}
        </ToolGroup>
        <ToolGroup>
          {btn(t("toolbar.formatGeneral"), "text", () => p.onFormat("general"))}
          {btn(t("toolbar.formatNumber"), "hash", () => p.onFormat("number"))}
          {btn(t("toolbar.formatPercent"), "percent", () => p.onFormat("percent"))}
          {btn(t("toolbar.formatCurrency"), "euro", () => p.onFormat("currency"))}
          {btn(t("toolbar.formatDate"), "calendar", () => p.onFormat("date"))}
          {btn(t("toolbar.decimalsMore"), "decimalsMore", () => p.onDecimals(1))}
          {btn(t("toolbar.decimalsLess"), "decimalsLess", () => p.onDecimals(-1))}
        </ToolGroup>
        <ToolGroup>
          {btn(t("toolbar.sortAsc"), "sortAsc", () => p.onSort(true))}
          {btn(t("toolbar.sortDesc"), "sortDesc", () => p.onSort(false))}
          {btn(t("toolbar.header"), "rows", p.onToggleHeader, {
            pressed: p.header,
            disabled: false,
          })}
          {btn(t("toolbar.filter"), "filter", p.onToggleFilter, {
            pressed: p.filterOn,
            disabled: false,
          })}
        </ToolGroup>
      </ToolBar>
    </div>
  );
}
