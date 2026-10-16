import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../shell/ui/Button";
import styles from "./SheetEditor.module.css";

function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [ref, onClose]);
}

export interface PopupMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  separator?: boolean;
  onSelect?(): void;
}

/** Menu contextuel positionné à la souris. */
export function ContextMenu({
  x,
  y,
  items,
  label,
  onClose,
}: {
  x: number;
  y: number;
  items: PopupMenuItem[];
  label: string;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    const focus = (n: number) => buttons[(n + buttons.length) % buttons.length]?.focus();
    if (e.key === "ArrowDown") focus(i + 1);
    else if (e.key === "ArrowUp") focus(i - 1);
    else if (e.key === "Escape") onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - items.length * 30 - 16);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={styles.popup}
      style={{ left: Math.max(0, left), top: Math.max(0, top) }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) =>
        item.separator ? (
          <div key={item.id} role="separator" className={styles.menuSep} />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={styles.menuItem}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

/** Menu contextuel de la grille (cellule, en-tête de ligne ou de colonne). */
export function SheetContextMenu({
  x,
  y,
  kind,
  readOnly,
  onAction,
  onClose,
}: {
  x: number;
  y: number;
  kind: "cell" | "row" | "col";
  readOnly: boolean;
  onAction(id: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation("sheet");
  const ro = readOnly;
  const item = (id: string, key: string, disabled = ro): PopupMenuItem => ({
    id,
    label: t(`menu.${key}`),
    disabled,
    onSelect: () => onAction(id),
  });
  const items: PopupMenuItem[] = [
    item("copy", "copy", false),
    item("cut", "cut"),
    item("paste", "paste"),
    item("clear", "clear"),
    { id: "sep", label: "", separator: true },
  ];
  if (kind !== "col") {
    items.push(
      item("rowAbove", "insertRowAbove"),
      item("rowBelow", "insertRowBelow"),
      item("deleteRow", "deleteRows"),
    );
  }
  if (kind !== "row") {
    items.push(
      item("colLeft", "insertColLeft"),
      item("colRight", "insertColRight"),
      item("deleteCol", "deleteCols"),
    );
  }
  return <ContextMenu x={x} y={y} items={items} label={t("menu.label")} onClose={onClose} />;
}

/** Menu de filtre d'une colonne : valeurs uniques à cocher + recherche. */
export function FilterPopup({
  anchor,
  values,
  excluded,
  onApply,
  onClose,
}: {
  anchor: DOMRect;
  values: string[];
  excluded: string[];
  onApply(excluded: string[]): void;
  onClose(): void;
}) {
  const { t } = useTranslation("sheet");
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState(
    () => new Set(values.filter((v) => !excluded.includes(v))),
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? values.filter((v) => v.toLowerCase().includes(q)) : values;
  }, [values, query]);
  const label = (v: string) => (v === "" ? t("filter.blank") : v);

  function toggle(v: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }
  function setAll(on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const v of shown) {
        if (on) next.add(v);
        else next.delete(v);
      }
      return next;
    });
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t("filter.title")}
      className={styles.popup}
      style={{
        left: Math.max(0, Math.min(anchor.left, window.innerWidth - 260)),
        top: Math.min(anchor.bottom + 2, window.innerHeight - 380),
        width: 250,
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <input
        className={styles.field}
        type="search"
        autoFocus
        value={query}
        placeholder={t("filter.search")}
        aria-label={t("filter.search")}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className={styles.popupActions} style={{ marginTop: 6, justifyContent: "flex-start" }}>
        <Button onClick={() => setAll(true)}>{t("filter.selectAll")}</Button>
        <Button onClick={() => setAll(false)}>{t("filter.selectNone")}</Button>
      </div>
      <ul className={styles.filterList}>
        {shown.map((v) => (
          <li key={v}>
            <label>
              <input type="checkbox" checked={checked.has(v)} onChange={() => toggle(v)} />
              <span>{label(v)}</span>
            </label>
          </li>
        ))}
        {shown.length === 0 && <li>{t("filter.none")}</li>}
      </ul>
      <div className={styles.popupActions}>
        <Button onClick={onClose}>{t("common:common.cancel")}</Button>
        <Button variant="primary" onClick={() => onApply(values.filter((v) => !checked.has(v)))}>
          {t("filter.apply")}
        </Button>
      </div>
    </div>
  );
}
