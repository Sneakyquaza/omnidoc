import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useTabs } from "../stores/tabs";
import { closeTabWithConfirm } from "./documents";
import { Icon } from "./ui/icons";
import styles from "./TabBar.module.css";

export function TabBar() {
  const { t } = useTranslation();
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const activate = useTabs((s) => s.activateTab);
  const move = useTabs((s) => s.moveTab);
  const listRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  function onKeyDown(e: KeyboardEvent, index: number, id: string) {
    const focusTab = (i: number) => {
      const target = tabs[(i + tabs.length) % tabs.length];
      if (!target) return;
      activate(target.id);
      listRef.current?.querySelector<HTMLElement>(`[data-tab="${target.id}"]`)?.focus();
    };
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      move(id, index + (e.key === "ArrowLeft" ? -1 : 1));
    } else if (e.key === "ArrowRight") focusTab(index + 1);
    else if (e.key === "ArrowLeft") focusTab(index - 1);
    else if (e.key === "Home") focusTab(0);
    else if (e.key === "End") focusTab(-1);
    else if (e.key === "Delete") void closeTabWithConfirm(id);
    else return;
    e.preventDefault();
  }

  return (
    <div className={styles.bar} role="tablist" aria-label={t("tabs.label")} ref={listRef}>
      {tabs.map((tab, index) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={`${styles.tab} ${active ? styles.active : ""}`}
            draggable
            onDragStart={() => setDragId(tab.id)}
            onDragOver={(e) => dragId && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId) move(dragId, index);
              setDragId(null);
            }}
            onDragEnd={() => setDragId(null)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                void closeTabWithConfirm(tab.id);
              }
            }}
          >
            <button
              type="button"
              role="tab"
              data-testid="tab"
              data-tab={tab.id}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={styles.label}
              title={tab.path ?? tab.title}
              onClick={() => activate(tab.id)}
              onKeyDown={(e) => onKeyDown(e, index, tab.id)}
            >
              <Icon name={tab.modelKind} />
              <span className={styles.title}>{tab.title}</span>
              {tab.dirty && (
                <span
                  className={styles.dirty}
                  data-testid="tab-dirty"
                  role="img"
                  aria-label={t("status.unsaved")}
                >
                  •
                </span>
              )}
            </button>
            <button
              type="button"
              className={styles.close}
              aria-label={t("tabs.close", { name: tab.title })}
              title={t("tabs.close", { name: tab.title })}
              tabIndex={active ? 0 : -1}
              onClick={() => void closeTabWithConfirm(tab.id)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
