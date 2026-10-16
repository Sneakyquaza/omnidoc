import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon } from "../../shell/ui/icons";
import { markdownOutline } from "./outline";
import { buildTree, flattenTree } from "./tree";
import type { TreeNode } from "./tree";
import styles from "./TextEditor.module.css";

export interface PanelSource {
  getText(): string;
  /** Change quand le texte a changé (calculs différés). */
  version: number;
  goTo(offset: number): void;
}

const ROW = 22;

export function TreePanel({ language, source }: { language: string; source: PanelSource }) {
  const { t } = useTranslation("text");
  const result = useMemo<{ tree: TreeNode | null; error: boolean }>(() => {
    try {
      return { tree: buildTree(language, source.getText()), error: false };
    } catch {
      return { tree: null, error: true };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, source.getText, source.version]);
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const [active, setActive] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const tree = result.tree;
  const open = useMemo(() => expanded ?? new Set(tree ? [tree.id] : []), [expanded, tree]);
  const rows = useMemo(() => (tree ? flattenTree(tree, open) : []), [tree, open]);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 12,
  });

  if (result.error) return <p className={styles.panelNote}>{t("tree.invalid")}</p>;
  if (!tree) return null;

  const toggle = (id: string, force?: boolean) => {
    const next = new Set(open);
    const want = force ?? !next.has(id);
    if (want) next.add(id);
    else next.delete(id);
    setExpanded(next);
  };

  const current = Math.min(active, rows.length - 1);
  const onKeyDown = (e: KeyboardEvent) => {
    const row = rows[current];
    if (!row) return;
    let next = current;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, current + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (e.key === "ArrowRight" && row.node.children.length > 0 && !row.expanded) {
      toggle(row.node.id, true);
    } else if (e.key === "ArrowLeft" && row.expanded) toggle(row.node.id, false);
    else if (e.key === "Enter" && row.node.offset !== undefined) source.goTo(row.node.offset);
    else return;
    e.preventDefault();
    if (next !== current) {
      setActive(next);
      virtualizer.scrollToIndex(next);
    }
  };

  return (
    <div
      ref={scrollRef}
      className={styles.tree}
      role="tree"
      aria-label={t("tree.label")}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index];
          if (!row) return null;
          const { node } = row;
          const hasChildren = node.children.length > 0;
          return (
            <div
              key={node.id}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={hasChildren ? row.expanded : undefined}
              aria-selected={v.index === current}
              className={`${styles.treeRow} ${v.index === current ? styles.treeActive : ""}`}
              style={{
                transform: `translateY(${v.start}px)`,
                height: ROW,
                paddingLeft: 4 + row.depth * 14,
              }}
              onClick={() => {
                setActive(v.index);
                if (node.offset !== undefined) source.goTo(node.offset);
              }}
            >
              <button
                type="button"
                tabIndex={-1}
                className={styles.treeToggle}
                aria-label={row.expanded ? t("tree.collapse") : t("tree.expand")}
                style={{ visibility: hasChildren ? "visible" : "hidden" }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(node.id);
                }}
              >
                <Icon name={row.expanded ? "chevronDown" : "chevronRight"} size={12} />
              </button>
              <span className={styles.treeKey}>{node.label}</span>
              {node.value !== undefined && (
                <span className={`${styles.treeValue} ${styles[`kind_${node.kind}`] ?? ""}`}>
                  {node.value}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function OutlinePanel({ source }: { source: PanelSource }) {
  const { t } = useTranslation("text");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => markdownOutline(source.getText()), [source.getText, source.version]);
  if (items.length === 0) return <p className={styles.panelNote}>{t("outline.empty")}</p>;
  return (
    <ul className={styles.outline} aria-label={t("outline.label")}>
      {items.map((item) => (
        <li key={item.offset}>
          <button
            type="button"
            className={styles.outlineItem}
            style={{ paddingLeft: 6 + (item.level - 1) * 12 }}
            onClick={() => source.goTo(item.offset)}
          >
            {item.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function InfoPanel({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className={styles.info}>
      {rows.map((r) => (
        <div key={r.label} className={styles.infoRow}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
