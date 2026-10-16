import { useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent, MouseEvent, MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Cell } from "../../ipc/bindings";
import { isFiltered } from "./filter";
import type { FilterState } from "./filter";
import { colToName, normalizeRange } from "./formula/ref";
import type { RangeBox } from "./formula/ref";
import { formatCell } from "./numfmt";
import type { Locale } from "./numfmt";
import styles from "./SheetEditor.module.css";

export const ROW_H = 22;
export const HEADER_H = 24;
export const ROW_HEADER_W = 52;

export interface Pos {
  r: number;
  c: number;
}

export interface Selection {
  anchor: Pos;
  focus: Pos;
}

export interface Editing {
  r: number;
  c: number;
  text: string;
  /** « enter » : saisie directe (les flèches valident) ; « edit » : F2 / formule (les flèches déplacent le curseur). */
  mode: "enter" | "edit";
  source: "cell" | "bar";
}

export interface GridApi {
  pageRows(): number;
  focus(): void;
}

export function selectionBox(sel: Selection): RangeBox {
  return normalizeRange({ r1: sel.anchor.r, c1: sel.anchor.c, r2: sel.focus.r, c2: sel.focus.c });
}

function lowerBound(order: number[] | null, r: number): number {
  if (!order) return r;
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((order[mid] as number) < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(order: number[] | null, r: number): number {
  if (!order) return r + 1;
  return lowerBound(order, r + 1);
}

interface GridProps {
  rows: Cell[][];
  /** Change à chaque modification du modèle. */
  version: number;
  rowCount: number;
  colCount: number;
  /** Lignes visibles (filtre) ; null = toutes. */
  rowOrder: number[] | null;
  colWidths: (number | null)[] | null;
  defaultColPx: number;
  charPx: number;
  sel: Selection;
  editing: Editing | null;
  locale: Locale;
  filter: FilterState;
  /** Nombre de colonnes de données (boutons de filtre). */
  dataCols: number;
  apiRef: MutableRefObject<GridApi | null>;
  label: string;
  filterLabel: string;
  onMouseDownCell(pos: Pos, e: MouseEvent): void;
  onDragCell(pos: Pos): void;
  onDoubleClickCell(pos: Pos): void;
  onHeader(kind: "row" | "col", index: number, e: MouseEvent): void;
  onResize(col: number, px: number): void;
  onContextMenu(
    target: { kind: "cell" | "row" | "col"; r: number; c: number },
    e: MouseEvent,
  ): void;
  onFilterButton(col: number, rect: DOMRect): void;
  onEditChange(text: string): void;
  onEditKeyDown(e: KeyboardEvent<HTMLInputElement>): void;
  onKeyDown(e: KeyboardEvent): void;
}

export function Grid(props: GridProps) {
  const {
    rows,
    rowCount,
    colCount,
    rowOrder,
    colWidths,
    defaultColPx,
    charPx,
    sel,
    editing,
    locale,
    filter,
    dataCols,
    apiRef,
  } = props;
  const { t } = useTranslation("sheet");
  const scrollRef = useRef<HTMLDivElement>(null);
  const nRows = rowOrder ? rowOrder.length : rowCount;
  const rowAt = (i: number) => (rowOrder ? (rowOrder[i] as number) : i);

  const widths = useMemo(() => {
    const out: number[] = [];
    for (let c = 0; c < colCount; c++) {
      const w = colWidths?.[c];
      out.push(w ? Math.max(16, Math.round(w * charPx)) : defaultColPx);
    }
    return out;
  }, [colWidths, colCount, charPx, defaultColPx]);
  const starts = useMemo(() => {
    const out = [0];
    for (const w of widths) out.push((out[out.length - 1] as number) + w);
    return out;
  }, [widths]);

  // eslint-disable-next-line react-hooks/incompatible-library
  const rowV = useVirtualizer({
    count: nRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
    scrollPaddingStart: HEADER_H,
  });
  const colV = useVirtualizer({
    horizontal: true,
    count: colCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widths[i] ?? defaultColPx,
    overscan: 3,
    scrollPaddingStart: ROW_HEADER_W,
  });
  useEffect(() => {
    colV.measure();
  }, [colV, widths]);

  useEffect(() => {
    apiRef.current = {
      pageRows: () =>
        Math.max(1, Math.floor(((scrollRef.current?.clientHeight ?? 400) - HEADER_H) / ROW_H) - 1),
      focus: () => scrollRef.current?.focus({ preventScroll: true }),
    };
  }, [apiRef]);

  // Garde la cellule active visible
  const focusRowIndex = lowerBound(rowOrder, sel.focus.r);
  useEffect(() => {
    if (focusRowIndex < nRows) rowV.scrollToIndex(focusRowIndex, { align: "auto" });
    if (sel.focus.c < colCount) colV.scrollToIndex(sel.focus.c, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRowIndex, sel.focus.c]);

  // Sélection à la souris
  const drag = useRef<{ last: string } | null>(null);
  function hit(e: { clientX: number; clientY: number }): Pos | null {
    const el = scrollRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left + el.scrollLeft - ROW_HEADER_W;
    const y = e.clientY - rect.top + el.scrollTop - HEADER_H;
    let c = 0;
    while (c < colCount - 1 && (starts[c + 1] as number) <= x) c++;
    const idx = Math.max(0, Math.min(nRows - 1, Math.floor(y / ROW_H)));
    return { r: rowAt(idx), c: Math.max(0, c) };
  }
  useEffect(() => {
    const move = (e: globalThis.MouseEvent) => {
      if (!drag.current) return;
      const p = hit(e);
      if (!p) return;
      const key = `${p.r}:${p.c}`;
      if (key === drag.current.last) return;
      drag.current.last = key;
      props.onDragCell(p);
    };
    const up = () => {
      drag.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  });

  function cellFromEvent(e: MouseEvent): Pos | null {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-r]");
    if (!el) return null;
    return { r: Number(el.dataset.r), c: Number(el.dataset.c) };
  }

  function startResize(col: number, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[col] ?? defaultColPx;
    const move = (ev: globalThis.MouseEvent) => props.onResize(col, startW + ev.clientX - startX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const box = selectionBox(sel);
  const rowItems = rowV.getVirtualItems();
  const colItems = colV.getVirtualItems();
  const totalW = ROW_HEADER_W + (starts[colCount] as number);
  const totalH = nRows * ROW_H;

  const rect = (b: RangeBox) => {
    const i1 = lowerBound(rowOrder, b.r1);
    const i2 = upperBound(rowOrder, b.r2);
    return {
      left: ROW_HEADER_W + (starts[Math.min(b.c1, colCount)] as number),
      top: i1 * ROW_H,
      width:
        (starts[Math.min(b.c2 + 1, colCount)] as number) -
        (starts[Math.min(b.c1, colCount)] as number),
      height: Math.max(0, i2 - i1) * ROW_H,
    };
  };
  const rangeRect = rect(box);
  const activeRect = rect({
    r1: sel.anchor.r,
    c1: sel.anchor.c,
    r2: sel.anchor.r,
    c2: sel.anchor.c,
  });
  const multi = box.r1 !== box.r2 || box.c1 !== box.c2;

  return (
    <div
      ref={scrollRef}
      className={styles.scroller}
      role="grid"
      tabIndex={0}
      aria-label={props.label}
      aria-rowcount={rowCount}
      aria-colcount={colCount}
      onKeyDown={props.onKeyDown}
    >
      <div className={styles.colStrip} style={{ width: totalW, height: HEADER_H }}>
        <div className={styles.corner} style={{ width: ROW_HEADER_W, height: HEADER_H }} />
        {colItems.map((ci) => {
          const selected = ci.index >= box.c1 && ci.index <= box.c2;
          return (
            <div
              key={ci.index}
              role="columnheader"
              className={`${styles.colHeader} ${selected ? styles.headerSelected : ""}`}
              style={{ left: ROW_HEADER_W + ci.start, width: ci.size, height: HEADER_H }}
              onMouseDown={(e) => props.onHeader("col", ci.index, e)}
              onContextMenu={(e) => props.onContextMenu({ kind: "col", r: 0, c: ci.index }, e)}
            >
              {colToName(ci.index)}
              <span
                className={styles.resizer}
                onMouseDown={(e) => startResize(ci.index, e)}
                aria-hidden="true"
              />
            </div>
          );
        })}
      </div>
      <div
        className={styles.body}
        style={{ width: totalW, height: totalH }}
        onMouseDown={(e) => {
          const p = cellFromEvent(e);
          if (!p || e.button !== 0) return;
          drag.current = { last: `${p.r}:${p.c}` };
          props.onMouseDownCell(p, e);
        }}
        onDoubleClick={(e) => {
          const p = cellFromEvent(e);
          if (p) props.onDoubleClickCell(p);
        }}
        onContextMenu={(e) => {
          const p = cellFromEvent(e);
          if (p) props.onContextMenu({ kind: "cell", ...p }, e);
        }}
      >
        <div className={styles.rowStrip} style={{ width: ROW_HEADER_W }}>
          {rowItems.map((ri) => {
            const r = rowAt(ri.index);
            const selected = r >= box.r1 && r <= box.r2;
            return (
              <div
                key={ri.index}
                role="rowheader"
                className={`${styles.rowHeader} ${selected ? styles.headerSelected : ""}`}
                style={{ top: ri.start, height: ROW_H, width: ROW_HEADER_W }}
                onMouseDown={(e) => props.onHeader("row", r, e)}
                onContextMenu={(e) => props.onContextMenu({ kind: "row", r, c: 0 }, e)}
              >
                {r + 1}
              </div>
            );
          })}
        </div>
        {rowItems.map((ri) => {
          const r = rowAt(ri.index);
          const row = rows[r];
          return colItems.map((ci) => {
            const cell = row?.[ci.index];
            const type = cell?.v.type;
            const text = cell ? formatCell(cell.v, cell.fmt, locale) : "";
            const cls = [
              styles.cell,
              type === "number" ? styles.num : "",
              type === "bool" ? styles.center : "",
              type === "error" ? `${styles.center} ${styles.error}` : "",
            ].join(" ");
            const showFilter = filter.enabled && r === 0 && ci.index < dataCols;
            return (
              <div
                key={`${ri.index}:${ci.index}`}
                role="gridcell"
                aria-rowindex={r + 1}
                aria-colindex={ci.index + 1}
                data-r={r}
                data-c={ci.index}
                className={cls}
                style={{
                  left: ROW_HEADER_W + ci.start,
                  top: ri.start,
                  width: ci.size,
                  height: ROW_H,
                }}
              >
                {text}
                {showFilter && (
                  <button
                    type="button"
                    className={`${styles.filterBtn} ${isFiltered(filter, ci.index) ? styles.filterActive : ""}`}
                    aria-label={props.filterLabel}
                    title={props.filterLabel}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) =>
                      props.onFilterButton(ci.index, e.currentTarget.getBoundingClientRect())
                    }
                  >
                    ▾
                  </button>
                )}
              </div>
            );
          });
        })}
        <div
          className={multi ? styles.range : styles.hidden}
          style={rangeRect}
          aria-hidden="true"
        />
        <div className={styles.active} style={activeRect} aria-hidden="true" />
        {editing && editing.source === "cell" && (
          <input
            className={styles.cellInput}
            style={{
              left: ROW_HEADER_W + (starts[Math.min(editing.c, colCount)] as number),
              top: lowerBound(rowOrder, editing.r) * ROW_H,
              minWidth: widths[editing.c] ?? defaultColPx,
              height: ROW_H,
            }}
            aria-label={t("grid.cellEditor")}
            value={editing.text}
            autoFocus
            spellCheck={false}
            onFocus={(e) => {
              const n = e.currentTarget.value.length;
              e.currentTarget.setSelectionRange(n, n);
            }}
            onChange={(e) => props.onEditChange(e.target.value)}
            onKeyDown={props.onEditKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        )}
      </div>
    </div>
  );
}
