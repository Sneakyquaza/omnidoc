import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DbValue } from "../../ipc/bindings";
import { editText, formatValue, isEditableValue, moveCell, nextCell, nextSelection } from "./logic";
import type { CellPos } from "./logic";
import styles from "./DatabaseEditor.module.css";

const ROW_HEIGHT = 24;
const COL_WIDTH = 170;
const NUM_WIDTH = 64;

export interface GridColumn {
  name: string;
  type?: string;
}

export interface GridContext {
  /** Colonne visée (index) ; `row` est défini pour une cellule, `null` pour un en-tête. */
  col: number;
  row: number | null;
  x: number;
  y: number;
}

interface Props {
  label: string;
  columns: GridColumn[];
  total: number;
  /** Ligne si déjà chargée. */
  getRow(index: number): DbValue[] | undefined;
  /** Appelé pour les lignes visibles non chargées. */
  onVisible?(index: number): void;
  /** Édition des cellules et sélection de lignes (absent = lecture seule). */
  editable?: boolean;
  /** Info-bulle expliquant pourquoi la grille n'est pas éditable. */
  readOnlyHint?: string;
  /** Valide une cellule : texte saisi, ou `null` pour NULL. Résout une fois l'opération terminée. */
  onEditCell?(row: number, col: number, text: string | null): Promise<void>;
  onSelectionChange?(rows: number[]): void;
  /** Touche Suppr avec des lignes sélectionnées. */
  onDeleteRows?(): void;
  onContext?(ctx: GridContext): void;
}

function Cell({
  value,
  active,
  editing,
  onMouseDown,
  onDoubleClick,
  onContextMenu,
  editor,
}: {
  value: DbValue | undefined;
  active: boolean;
  editing: boolean;
  onMouseDown?(e: MouseEvent): void;
  onDoubleClick?(): void;
  onContextMenu?(e: MouseEvent): void;
  editor?: ReactNode;
}) {
  const activeCls = active ? ` ${styles.cellActive}` : "";
  if (!value)
    return <div className={styles.cell + activeCls} role="gridcell" onMouseDown={onMouseDown} />;
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
    <div
      className={cls + activeCls}
      role="gridcell"
      aria-selected={active}
      title={value.type === "null" ? undefined : text}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {editing ? editor : text}
    </div>
  );
}

interface EditResult {
  text: string | null;
  move: "none" | "next" | "back";
  /** Terminé par perte de focus : ne pas rendre le focus à la grille. */
  blur?: boolean;
}

interface EditorProps {
  initial: string;
  onDone(result: EditResult): void;
}

/** Champ de saisie inline : Entrée valide, Échap annule, Tab valide et passe à la suivante. */
function CellEditor({ initial, onDone }: EditorProps) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  function finish(commit: boolean, move: "none" | "next" | "back", blur = false) {
    if (done.current) return;
    done.current = true;
    onDone({ text: commit ? text : null, move, blur });
  }
  return (
    <input
      ref={ref}
      className={styles.cellInput}
      value={text}
      data-testid="db-cell-input"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true, "none");
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false, "none");
        } else if (e.key === "Tab") {
          e.preventDefault();
          finish(true, e.shiftKey ? "back" : "next");
        }
      }}
      onBlur={() => finish(true, "none", true)}
    />
  );
}

export function DataGrid({
  label,
  columns,
  total,
  getRow,
  onVisible,
  editable,
  readOnlyHint,
  onEditCell,
  onSelectionChange,
  onDeleteRows,
  onContext,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<CellPos | null>(null);
  const [editing, setEditing] = useState<CellPos | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
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

  function startEdit(pos: CellPos) {
    if (!editable) return;
    if (isEditableValue(getRow(pos.row)?.[pos.col])) {
      setActive(pos);
      setEditing(pos);
    }
  }

  function select(pos: CellPos) {
    setActive(pos);
    virtualizer.scrollToIndex(pos.row);
  }

  function onGridKeyDown(e: KeyboardEvent) {
    if (editing || !active) return;
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEdit(active);
    } else if (e.key === "Delete" && selected.size > 0) {
      e.preventDefault();
      onDeleteRows?.();
    } else if (e.key === "Tab") {
      const next = nextCell(active, total, columns.length, e.shiftKey);
      if (next) {
        e.preventDefault();
        select(next);
      }
    } else {
      const next = moveCell(active, e.key, total, columns.length);
      if (next !== active) {
        e.preventDefault();
        select(next);
      }
    }
  }

  function onRowNumber(e: MouseEvent, index: number) {
    if (!editable) return;
    const r = nextSelection(selected, anchor, index, {
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
    });
    setSelected(r.selected);
    setAnchor(r.anchor);
    onSelectionChange?.([...r.selected].sort((a, b) => a - b));
    scrollerRef.current?.focus();
  }

  async function finishEdit(pos: CellPos, res: EditResult) {
    setEditing(null);
    if (!res.blur) scrollerRef.current?.focus();
    if (res.text !== null && res.text !== editText(getRow(pos.row)?.[pos.col])) {
      await onEditCell?.(pos.row, pos.col, res.text);
    }
    if (res.move !== "none") {
      const next = nextCell(pos, total, columns.length, res.move === "back");
      if (next) {
        select(next);
        startEdit(next);
        return;
      }
    }
    if (!res.blur) scrollerRef.current?.focus();
  }

  return (
    <div
      className={styles.gridScroller}
      ref={scrollerRef}
      role="grid"
      aria-label={label}
      aria-rowcount={total + 1}
      aria-readonly={!editable}
      title={!editable ? readOnlyHint : undefined}
      tabIndex={0}
      onKeyDown={onGridKeyDown}
    >
      <div style={{ width, minWidth: "100%" }}>
        <div className={styles.headRow} role="row">
          <div className={`${styles.headCell} ${styles.numCell}`} role="columnheader">
            #
          </div>
          {columns.map((c, i) => (
            <div
              key={i}
              className={styles.headCell}
              role="columnheader"
              title={c.name}
              onContextMenu={(e) => {
                if (!onContext) return;
                e.preventDefault();
                onContext({ col: i, row: null, x: e.clientX, y: e.clientY });
              }}
            >
              <span className={styles.colName}>{c.name}</span>
              {c.type ? <span className={styles.colType}>{c.type}</span> : null}
            </div>
          ))}
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((item) => {
            const row = getRow(item.index);
            const isSel = selected.has(item.index);
            return (
              <div
                key={item.key}
                className={`${styles.row} ${isSel ? styles.rowSelected : ""}`}
                role="row"
                aria-rowindex={item.index + 2}
                aria-selected={isSel}
                style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
              >
                <div
                  className={`${styles.cell} ${styles.numCell}`}
                  role="gridcell"
                  data-testid="db-row-number"
                  onMouseDown={(e) => onRowNumber(e, item.index)}
                >
                  {item.index + 1}
                </div>
                {columns.map((_, c) => {
                  const pos = { row: item.index, col: c };
                  const isActive = active?.row === pos.row && active.col === c;
                  const isEditing = editing?.row === pos.row && editing.col === c;
                  return (
                    <Cell
                      key={c}
                      value={row?.[c]}
                      active={isActive}
                      editing={isEditing}
                      onMouseDown={() => {
                        if (!isEditing) {
                          setActive(pos);
                          scrollerRef.current?.focus();
                        }
                      }}
                      onDoubleClick={() => startEdit(pos)}
                      onContextMenu={(e) => {
                        if (!onContext) return;
                        e.preventDefault();
                        setActive(pos);
                        onContext({ col: c, row: item.index, x: e.clientX, y: e.clientY });
                      }}
                      editor={
                        <CellEditor
                          initial={editText(row?.[c])}
                          onDone={(res) => void finishEdit(pos, res)}
                        />
                      }
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
