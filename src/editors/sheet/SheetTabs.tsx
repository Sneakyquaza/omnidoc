import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../shell/ui/icons";
import { ContextMenu } from "./Popups";
import styles from "./SheetEditor.module.css";

interface SheetTabsProps {
  names: string[];
  active: number;
  readOnly: boolean;
  onSelect(index: number): void;
  onAdd(): void;
  onRename(index: number, name: string): void;
  onDelete(index: number): void;
  onMove(from: number, to: number): void;
}

export function SheetTabs(p: SheetTabsProps) {
  const { t } = useTranslation("sheet");
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming !== null) inputRef.current?.select();
  }, [renaming]);

  function startRename(i: number) {
    if (p.readOnly) return;
    setDraft(p.names[i] ?? "");
    setRenaming(i);
  }
  function commitRename() {
    if (renaming === null) return;
    const name = draft.trim();
    if (name && name !== p.names[renaming]) p.onRename(renaming, name);
    setRenaming(null);
  }
  function onKeyDown(e: KeyboardEvent, i: number) {
    if (e.key === "F2") {
      e.preventDefault();
      startRename(i);
    } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !p.readOnly) {
      e.preventDefault();
      const to = i + (e.key === "ArrowLeft" ? -1 : 1);
      if (to >= 0 && to < p.names.length) p.onMove(i, to);
    }
  }

  return (
    <div className={styles.tabs} role="tablist" aria-label={t("tabs.label")}>
      {p.names.map((name, i) => (
        <div
          key={`${i}:${name}`}
          role="presentation"
          draggable={!p.readOnly && renaming === null}
          className={
            dropAt === i && dragFrom !== null && dragFrom !== i ? styles.tabDrop : undefined
          }
          onDragStart={() => setDragFrom(i)}
          onDragOver={(e) => {
            if (dragFrom === null) return;
            e.preventDefault();
            setDropAt(i);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragFrom !== null && dragFrom !== i) p.onMove(dragFrom, i);
            setDragFrom(null);
            setDropAt(null);
          }}
          onDragEnd={() => {
            setDragFrom(null);
            setDropAt(null);
          }}
        >
          {renaming === i ? (
            <input
              ref={inputRef}
              className={styles.tabInput}
              aria-label={t("tabs.rename")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <button
              type="button"
              role="tab"
              aria-selected={i === p.active}
              className={`${styles.tab} ${i === p.active ? styles.tabActive : ""}`}
              onClick={() => p.onSelect(i)}
              onDoubleClick={() => startRename(i)}
              onKeyDown={(e) => onKeyDown(e, i)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, index: i });
              }}
            >
              {name}
              {i === p.active && p.names.length > 1 && !p.readOnly && (
                <span
                  role="button"
                  tabIndex={0}
                  className={styles.tabClose}
                  aria-label={t("tabs.delete")}
                  title={t("tabs.delete")}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onDelete(i);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      p.onDelete(i);
                    }
                  }}
                >
                  <Icon name="close" size={12} />
                </span>
              )}
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className={styles.tab}
        aria-label={t("tabs.add")}
        title={t("tabs.add")}
        disabled={p.readOnly}
        onClick={p.onAdd}
      >
        +
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t("tabs.label")}
          onClose={() => setMenu(null)}
          items={[
            {
              id: "rename",
              label: t("tabs.rename"),
              disabled: p.readOnly,
              onSelect: () => startRename(menu.index),
            },
            {
              id: "left",
              label: t("tabs.moveLeft"),
              disabled: p.readOnly || menu.index === 0,
              onSelect: () => p.onMove(menu.index, menu.index - 1),
            },
            {
              id: "right",
              label: t("tabs.moveRight"),
              disabled: p.readOnly || menu.index >= p.names.length - 1,
              onSelect: () => p.onMove(menu.index, menu.index + 1),
            },
            { id: "sep", label: "", separator: true },
            {
              id: "delete",
              label: t("tabs.delete"),
              disabled: p.readOnly || p.names.length <= 1,
              onSelect: () => p.onDelete(menu.index),
            },
          ]}
        />
      )}
    </div>
  );
}
