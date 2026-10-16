import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DbValue } from "../../ipc/bindings";
import { formatValue } from "./logic";
import styles from "./DatabaseEditor.module.css";

const ROW_HEIGHT = 24;
const COL_WIDTH = 170;
const NUM_WIDTH = 64;

export interface GridColumn {
  name: string;
  type?: string;
}

interface Props {
  label: string;
  columns: GridColumn[];
  total: number;
  /** Ligne si déjà chargée. */
  getRow(index: number): DbValue[] | undefined;
  /** Appelé pour les lignes visibles non chargées. */
  onVisible?(index: number): void;
}

function Cell({ value }: { value: DbValue | undefined }) {
  if (!value) return <div className={styles.cell} role="gridcell" />;
  const cls =
    value.type === "null"
      ? `${styles.cell} ${styles.null}`
      : value.type === "blob"
        ? `${styles.cell} ${styles.blob}`
        : value.type === "int" || value.type === "real"
          ? `${styles.cell} ${styles.num}`
          : styles.cell;
  const text = formatValue(value);
  return (
    <div className={cls} role="gridcell" title={value.type === "null" ? undefined : text}>
      {text}
    </div>
  );
}

export function DataGrid({ label, columns, total, getRow, onVisible }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });
  const items = virtualizer.getVirtualItems();
  const width = NUM_WIDTH + columns.length * COL_WIDTH;

  useEffect(() => {
    if (!onVisible) return;
    for (const item of items) {
      if (!getRow(item.index)) onVisible(item.index);
    }
  });

  return (
    <div
      className={styles.gridScroller}
      ref={scrollerRef}
      role="grid"
      aria-label={label}
      aria-rowcount={total + 1}
      tabIndex={0}
    >
      <div style={{ width, minWidth: "100%" }}>
        <div className={styles.headRow} role="row">
          <div className={`${styles.headCell} ${styles.numCell}`} role="columnheader">
            #
          </div>
          {columns.map((c, i) => (
            <div key={i} className={styles.headCell} role="columnheader" title={c.name}>
              <span className={styles.colName}>{c.name}</span>
              {c.type ? <span className={styles.colType}>{c.type}</span> : null}
            </div>
          ))}
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((item) => {
            const row = getRow(item.index);
            return (
              <div
                key={item.key}
                className={styles.row}
                role="row"
                aria-rowindex={item.index + 2}
                style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
              >
                <div className={`${styles.cell} ${styles.numCell}`} role="gridcell">
                  {item.index + 1}
                </div>
                {columns.map((_, c) => (
                  <Cell key={c} value={row?.[c]} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
