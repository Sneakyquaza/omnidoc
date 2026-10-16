import { useTranslation } from "react-i18next";
import { Button } from "../../shell/ui/Button";
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

function Sep() {
  return <span className={styles.sep} role="separator" aria-orientation="vertical" />;
}

export function SheetToolbar(p: SheetToolbarProps) {
  const { t } = useTranslation("sheet");
  const btn = (
    label: string,
    text: string,
    onClick: () => void,
    opts?: { pressed?: boolean; disabled?: boolean },
  ) => (
    <Button
      variant="ghost"
      className={`${styles.tbBtn} ${opts?.pressed ? styles.pressed : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={opts?.pressed}
      disabled={opts?.disabled ?? p.readOnly}
      onClick={onClick}
    >
      {text}
    </Button>
  );
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={t("toolbar.label")}>
      {btn(t("toolbar.undo"), "↶", p.onUndo, { disabled: p.readOnly || !p.canUndo })}
      {btn(t("toolbar.redo"), "↷", p.onRedo, { disabled: p.readOnly || !p.canRedo })}
      <Sep />
      {btn(t("toolbar.formatGeneral"), t("toolbar.general"), () => p.onFormat("general"))}
      {btn(t("toolbar.formatNumber"), "1,0", () => p.onFormat("number"))}
      {btn(t("toolbar.formatPercent"), "%", () => p.onFormat("percent"))}
      {btn(t("toolbar.formatCurrency"), "€", () => p.onFormat("currency"))}
      {btn(t("toolbar.formatDate"), t("toolbar.date"), () => p.onFormat("date"))}
      {btn(t("toolbar.decimalsMore"), ".0+", () => p.onDecimals(1))}
      {btn(t("toolbar.decimalsLess"), ".0−", () => p.onDecimals(-1))}
      <Sep />
      {btn(t("toolbar.sortAsc"), "A→Z", () => p.onSort(true))}
      {btn(t("toolbar.sortDesc"), "Z→A", () => p.onSort(false))}
      {btn(t("toolbar.header"), t("toolbar.headerShort"), p.onToggleHeader, {
        pressed: p.header,
        disabled: false,
      })}
      {btn(t("toolbar.filter"), t("toolbar.filterShort"), p.onToggleFilter, {
        pressed: p.filterOn,
        disabled: false,
      })}
    </div>
  );
}
