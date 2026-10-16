import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../../ipc/bindings";
import type { Cell, CsvOptions, Sheet, Workbook } from "../../ipc/bindings";
import { reportError } from "../../shell/errors";
import { basename } from "../../shell/paths";
import { EditorSidePanel, EditorToolbar } from "../../shell/slots";
import { confirm } from "../../shell/ui/dialogStore";
import { pushToast } from "../../shell/ui/toastStore";
import type { EditorProps } from "../types";
import { NO_FILTER, uniqueValues, visibleRows } from "./filter";
import type { FilterState } from "./filter";
import { Engine } from "./formula/engine";
import type { CellChange } from "./formula/engine";
import { offsetFormula } from "./formula/rewrite";
import { MAX_COLS, MAX_ROWS, normalizeRange, parseRangeText, rangeName } from "./formula/ref";
import type { RangeBox } from "./formula/ref";
import { FormulaBar } from "./FormulaBar";
import { Grid, selectionBox } from "./Grid";
import type { Editing, GridApi, Pos, Selection } from "./Grid";
import { History } from "./history";
import { cellInputText, parseCellInput } from "./input";
import {
  CHAR_PX,
  DEFAULT_COL_PX,
  EMPTY_CELL,
  MIN_COL_PX,
  buildWorkbook,
  cellToScalar,
  cloneSheets,
  isEmptyCell,
  usedExtent,
} from "./model";
import { ctrlArrow, stepRow } from "./nav";
import { changeDecimals, formatCell, formatNumber } from "./numfmt";
import type { Locale } from "./numfmt";
import { FilterPopup, SheetContextMenu } from "./Popups";
import { SheetPanel } from "./SheetPanel";
import { SheetTabs } from "./SheetTabs";
import { SheetToolbar } from "./SheetToolbar";
import type { FormatKind } from "./SheetToolbar";
import { sortChanges } from "./sort";
import {
  addSheet,
  deleteAxis,
  deleteSheet,
  insertAxis,
  moveSheet,
  renameSheet,
  uniqueSheetName,
} from "./structure";
import { parseTsv, serializeTsv } from "./tsv";
import styles from "./SheetEditor.module.css";

interface Snapshot {
  sheets: Sheet[];
  active: number;
}

type Entry =
  | { kind: "cells"; before: CellChange[]; after: CellChange[] }
  | { kind: "sheets"; before: Snapshot; after: Snapshot };

interface Clip {
  text: string;
  cells: Cell[][];
  r: number;
  c: number;
}

type MenuKind = "cell" | "row" | "col";

const START: Selection = { anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } };
const FORMAT_MAX_CELLS = 1000;

function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  const x = a ?? EMPTY_CELL;
  const y = b ?? EMPTY_CELL;
  return x === y || (x.f === y.f && x.fmt === y.fmt && JSON.stringify(x.v) === JSON.stringify(y.v));
}

function currencyFormat(): string {
  return '#,##0.00 "€"';
}

export default function SheetEditor({
  model,
  readOnly,
  setDirty,
  registerSerializer,
  registerCommands,
  setStatus,
}: EditorProps<Workbook>) {
  const { t, i18n } = useTranslation("sheet");
  const locale: Locale = i18n.language.startsWith("fr") ? "fr" : "en";

  const [engine] = useState(() => {
    const e = new Engine({ locale });
    const sheets = cloneSheets(model.sheets);
    if (sheets.length === 0) sheets.push({ name: t("sheetBase"), rows: [], colWidths: null });
    e.load(sheets, true);
    return e;
  });
  const [history] = useState(() => new History<Entry>(60));
  const [version, setVersion] = useState(0);
  const [active, setActive] = useState(0);
  const [sel, setSel] = useState<Selection>(START);
  const [grow, setGrow] = useState({ rows: 0, cols: 0 });
  const [editing, setEditingState] = useState<Editing | null>(null);
  const [csv, setCsv] = useState<CsvOptions | null>(model.csv);
  const [filters, setFilters] = useState<Record<number, FilterState>>({});
  const [header, setHeader] = useState(model.csv?.header ?? false);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: MenuKind } | null>(null);
  const [filterPop, setFilterPop] = useState<{ col: number; rect: DOMRect } | null>(null);

  const editingRef = useRef<Editing | null>(null);
  const csvRef = useRef(csv);
  const clipRef = useRef<Clip | null>(null);
  const gridApi = useRef<GridApi | null>(null);
  const actions = useRef<Record<string, () => void>>({});

  useEffect(() => {
    engine.setLocale(locale);
  }, [engine, locale]);
  useEffect(() => {
    csvRef.current = csv;
  }, [csv]);

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const setEditing = useCallback((e: Editing | null) => {
    editingRef.current = e;
    setEditingState(e);
  }, []);

  const sheet = engine.sheets[active] ?? (engine.sheets[0] as Sheet);
  const filter = filters[active] ?? NO_FILTER;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const used = useMemo(() => usedExtent(sheet.rows), [sheet, version]);
  const rowCount = Math.min(MAX_ROWS, Math.max(100, used.rows + 50, grow.rows));
  const colCount = Math.min(MAX_COLS, Math.max(26, used.cols + 5, grow.cols));
  const box = selectionBox(sel);

  const display = useCallback(
    (cell: Cell | undefined) => (cell ? formatCell(cell.v, cell.fmt, locale) : ""),
    [locale],
  );
  const rowOrder = useMemo(
    () => visibleRows(sheet.rows, rowCount, filter, display),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheet, version, rowCount, filter, display],
  );

  const cellAt = (r: number, c: number): Cell | undefined => engine.getCell(active, r, c);

  // ---------- Modifications ----------

  const apply = useCallback(
    (changes: CellChange[]) => {
      if (readOnly) return;
      const effective = changes.filter(
        (ch) => !sameCell(engine.getCell(ch.sheet, ch.row, ch.col), ch.cell ?? undefined),
      );
      if (effective.length === 0) return;
      const before: CellChange[] = effective.map((ch) => ({
        sheet: ch.sheet,
        row: ch.row,
        col: ch.col,
        cell: engine.getCell(ch.sheet, ch.row, ch.col) ?? null,
      }));
      engine.setCells(effective);
      history.push({ kind: "cells", before, after: effective });
      setDirty(true);
      bump();
    },
    [engine, history, readOnly, setDirty, bump],
  );

  const replaceSheets = useCallback(
    (next: Sheet[], newActive: number) => {
      if (readOnly) return;
      const before: Snapshot = { sheets: cloneSheets(engine.sheets), active };
      engine.load(next);
      history.push({
        kind: "sheets",
        before,
        after: { sheets: cloneSheets(engine.sheets), active: newActive },
      });
      setActive(newActive);
      setFilters({});
      setGrow({ rows: 0, cols: 0 });
      setSel((s) => ({
        anchor: { r: Math.min(s.anchor.r, MAX_ROWS - 1), c: s.anchor.c },
        focus: { r: Math.min(s.focus.r, MAX_ROWS - 1), c: s.focus.c },
      }));
      setDirty(true);
      bump();
    },
    [engine, history, readOnly, active, setDirty, bump],
  );

  function cellsInBox(b: RangeBox, clamp: boolean): Pos[] {
    const out: Pos[] = [];
    const r2 = clamp ? Math.min(b.r2, used.rows - 1) : b.r2;
    const c2 = clamp ? Math.min(b.c2, used.cols - 1) : b.c2;
    for (let r = b.r1; r <= r2; r++) for (let c = b.c1; c <= c2; c++) out.push({ r, c });
    return out;
  }

  function clearSelection() {
    const changes: CellChange[] = [];
    for (const { r, c } of cellsInBox(box, true)) {
      const prev = cellAt(r, c);
      if (!prev || (prev.v.type === "empty" && !prev.f)) continue;
      changes.push({
        sheet: active,
        row: r,
        col: c,
        cell: prev.fmt ? { v: EMPTY_CELL.v, f: null, fmt: prev.fmt } : null,
      });
    }
    apply(changes);
  }

  function applyToSelectionCells(fn: (cell: Cell) => Cell) {
    const area = (box.r2 - box.r1 + 1) * (box.c2 - box.c1 + 1);
    const changes: CellChange[] = [];
    for (const { r, c } of cellsInBox(box, area > FORMAT_MAX_CELLS)) {
      const prev = cellAt(r, c) ?? EMPTY_CELL;
      changes.push({ sheet: active, row: r, col: c, cell: fn(prev) });
    }
    apply(changes);
  }

  function applyFormat(kind: FormatKind) {
    const fmt: Record<FormatKind, string | null> = {
      general: null,
      number: "#,##0.00",
      percent: "0.00%",
      currency: currencyFormat(),
      date: locale === "fr" ? "dd/mm/yyyy" : "yyyy-mm-dd",
    };
    applyToSelectionCells((cell) => ({ ...cell, fmt: fmt[kind] }));
  }

  function changeDecimalsOfSelection(delta: 1 | -1) {
    applyToSelectionCells((cell) =>
      cell.v.type === "number" || cell.f ? { ...cell, fmt: changeDecimals(cell.fmt, delta) } : cell,
    );
  }

  function fillDown() {
    if (readOnly || editingRef.current) return;
    const srcRow = box.r1 === box.r2 ? box.r1 - 1 : box.r1;
    if (srcRow < 0) return;
    const changes: CellChange[] = [];
    for (let c = box.c1; c <= box.c2; c++) {
      const src = cellAt(srcRow, c);
      for (let r = Math.max(box.r1, srcRow + 1); r <= box.r2; r++) {
        const cell = src?.f ? { ...src, f: offsetFormula(src.f, r - srcRow, 0) } : (src ?? null);
        changes.push({ sheet: active, row: r, col: c, cell });
      }
    }
    apply(changes);
  }

  function undoRedo(kind: "undo" | "redo") {
    if (readOnly || editingRef.current) return;
    const entry = kind === "undo" ? history.undo() : history.redo();
    if (!entry) return;
    if (entry.kind === "cells") {
      const list = kind === "undo" ? entry.before : entry.after;
      engine.setCells(list);
      const first = list[0];
      if (first) {
        setActive(first.sheet);
        setSel({ anchor: { r: first.row, c: first.col }, focus: { r: first.row, c: first.col } });
      }
    } else {
      const snap = kind === "undo" ? entry.before : entry.after;
      engine.load(cloneSheets(snap.sheets));
      setActive(snap.active);
      setFilters({});
    }
    setDirty(true);
    bump();
  }

  // ---------- Sélection / navigation ----------

  const select = useCallback((pos: Pos, extend = false) => {
    const p = {
      r: Math.max(0, Math.min(MAX_ROWS - 1, pos.r)),
      c: Math.max(0, Math.min(MAX_COLS - 1, pos.c)),
    };
    setGrow((g) => ({ rows: Math.max(g.rows, p.r + 30), cols: Math.max(g.cols, p.c + 6) }));
    setSel((s) => (extend ? { anchor: s.anchor, focus: p } : { anchor: p, focus: p }));
  }, []);

  function moveAfterEdit(move: "down" | "up" | "right" | "left" | "none") {
    const p = sel.anchor;
    if (move === "down") select({ r: stepRow(rowOrder, p.r, 1), c: p.c });
    else if (move === "up") select({ r: stepRow(rowOrder, p.r, -1), c: p.c });
    else if (move === "right") select({ r: p.r, c: p.c + 1 });
    else if (move === "left") select({ r: p.r, c: p.c - 1 });
  }

  function startEdit(
    mode: "enter" | "edit",
    text?: string,
    source: "cell" | "bar" = "cell",
    at?: Pos,
  ) {
    if (readOnly) return;
    const p = at ?? sel.anchor;
    setEditing({
      r: p.r,
      c: p.c,
      text: text ?? cellInputText(cellAt(p.r, p.c), locale),
      mode,
      source,
    });
  }

  function commitEdit(move: "down" | "up" | "right" | "left" | "none") {
    const ed = editingRef.current;
    if (!ed) return;
    setEditing(null);
    const prev = cellAt(ed.r, ed.c);
    if (ed.text !== cellInputText(prev, locale)) {
      apply([{ sheet: active, row: ed.r, col: ed.c, cell: parseCellInput(ed.text, locale, prev) }]);
    }
    moveAfterEdit(move);
    gridApi.current?.focus();
  }

  function cancelEdit() {
    setEditing(null);
    gridApi.current?.focus();
  }

  function onEditKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    const ed = editingRef.current;
    if (!ed) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit(e.shiftKey ? "up" : "down");
    } else if (e.key === "Tab") {
      e.preventDefault();
      commitEdit(e.shiftKey ? "left" : "right");
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    } else if (
      ed.mode === "enter" &&
      ed.source === "cell" &&
      !ed.text.startsWith("=") &&
      (e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight")
    ) {
      e.preventDefault();
      const move = {
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
      } as const;
      commitEdit(move[e.key as keyof typeof move]);
    }
  }

  function selectAll() {
    select({ r: 0, c: 0 });
    setSel({
      anchor: { r: 0, c: 0 },
      focus: { r: Math.max(0, used.rows - 1), c: Math.max(0, used.cols - 1) },
    });
  }

  async function copySelection(cut: boolean) {
    const grid: string[][] = [];
    const cells: Cell[][] = [];
    for (let r = box.r1; r <= box.r2; r++) {
      const line: string[] = [];
      const raw: Cell[] = [];
      for (let c = box.c1; c <= box.c2; c++) {
        const cell = cellAt(r, c);
        line.push(display(cell));
        raw.push(cell ?? EMPTY_CELL);
      }
      grid.push(line);
      cells.push(raw);
    }
    const text = serializeTsv(grid);
    clipRef.current = { text, cells, r: box.r1, c: box.c1 };
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      pushToast({ kind: "error", text: t("errors.clipboard") });
      return;
    }
    if (cut) clearSelection();
  }

  async function pasteClipboard() {
    if (readOnly) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      pushToast({ kind: "error", text: t("errors.clipboard") });
      return;
    }
    const clip = clipRef.current;
    const start = { r: box.r1, c: box.c1 };
    let grid: Cell[][];
    if (clip && clip.text === text) {
      const dr = start.r - clip.r;
      const dc = start.c - clip.c;
      grid = clip.cells.map((row) =>
        row.map((cell) => (cell.f ? { ...cell, f: offsetFormula(cell.f, dr, dc) } : cell)),
      );
    } else {
      grid = parseTsv(text).map((row) => row.map((field) => parseCellInput(field, locale)));
    }
    if (grid.length === 0) return;
    const multi = box.r1 !== box.r2 || box.c1 !== box.c2;
    const changes: CellChange[] = [];
    let endR = start.r + grid.length - 1;
    let endC = start.c + Math.max(...grid.map((r) => r.length)) - 1;
    if (grid.length === 1 && grid[0]?.length === 1 && multi) {
      const only = grid[0][0] as Cell;
      for (let r = box.r1; r <= box.r2; r++) {
        for (let c = box.c1; c <= box.c2; c++) {
          const cell = only.f
            ? { ...only, f: offsetFormula(only.f, r - start.r, c - start.c) }
            : only;
          changes.push({ sheet: active, row: r, col: c, cell });
        }
      }
      endR = box.r2;
      endC = box.c2;
    } else {
      grid.forEach((row, i) =>
        row.forEach((cell, j) =>
          changes.push({ sheet: active, row: start.r + i, col: start.c + j, cell }),
        ),
      );
    }
    apply(changes);
    setGrow((g) => ({ rows: Math.max(g.rows, endR + 30), cols: Math.max(g.cols, endC + 6) }));
    setSel({ anchor: start, focus: { r: endR, c: endC } });
    gridApi.current?.focus();
  }

  function onGridKeyDown(e: KeyboardEvent) {
    if (editingRef.current) return;
    const mod = e.ctrlKey || e.metaKey;
    const cur = e.shiftKey ? sel.focus : sel.anchor;
    const extend = e.shiftKey;
    const filled = (r: number, c: number) => !isEmptyCell(cellAt(r, c));
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const arrow = arrows[e.key];
    if (arrow) {
      e.preventDefault();
      const [dr, dc] = arrow;
      if (mod) {
        select(ctrlArrow(filled, cur, dr, dc, rowCount, colCount), extend);
      } else {
        const r = dr === 0 ? cur.r : stepRow(rowOrder, cur.r, dr as 1 | -1);
        select({ r, c: cur.c + dc }, extend);
      }
      return;
    }
    switch (e.key) {
      case "Tab":
        e.preventDefault();
        select({ r: sel.anchor.r, c: sel.anchor.c + (e.shiftKey ? -1 : 1) });
        return;
      case "Enter":
        e.preventDefault();
        select({ r: stepRow(rowOrder, sel.anchor.r, e.shiftKey ? -1 : 1), c: sel.anchor.c });
        return;
      case "Home":
        e.preventDefault();
        select(mod ? { r: 0, c: 0 } : { r: cur.r, c: 0 }, extend);
        return;
      case "End": {
        e.preventDefault();
        if (mod) {
          select({ r: Math.max(0, used.rows - 1), c: Math.max(0, used.cols - 1) }, extend);
        } else {
          let last = 0;
          const row = sheet.rows[cur.r] ?? [];
          for (let c = row.length - 1; c >= 0; c--) {
            if (!isEmptyCell(row[c])) {
              last = c;
              break;
            }
          }
          select({ r: cur.r, c: last }, extend);
        }
        return;
      }
      case "PageDown":
      case "PageUp": {
        e.preventDefault();
        const page = (gridApi.current?.pageRows() ?? 20) * (e.key === "PageDown" ? 1 : -1);
        select({ r: cur.r + page, c: cur.c }, extend);
        return;
      }
      case "F2":
        e.preventDefault();
        startEdit("edit");
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        clearSelection();
        return;
      default:
        break;
    }
    if (mod) {
      const key = e.key.toLowerCase();
      if (key === "a") {
        e.preventDefault();
        selectAll();
      } else if (key === "c") {
        e.preventDefault();
        void copySelection(false);
      } else if (key === "x") {
        e.preventDefault();
        void copySelection(!readOnly);
      } else if (key === "v") {
        e.preventDefault();
        void pasteClipboard();
      }
      return;
    }
    if (e.key.length === 1 && !e.altKey) {
      e.preventDefault();
      startEdit("enter", e.key);
    }
  }

  // ---------- Structure : lignes, colonnes, feuilles ----------

  function insertRows(below: boolean) {
    const count = box.r2 - box.r1 + 1;
    replaceSheets(
      insertAxis(engine.sheets, active, "row", below ? box.r2 + 1 : box.r1, count),
      active,
    );
  }
  function deleteRows() {
    replaceSheets(deleteAxis(engine.sheets, active, "row", box.r1, box.r2 - box.r1 + 1), active);
  }
  function insertCols(right: boolean) {
    const count = box.c2 - box.c1 + 1;
    replaceSheets(
      insertAxis(engine.sheets, active, "col", right ? box.c2 + 1 : box.c1, count),
      active,
    );
  }
  function deleteCols() {
    replaceSheets(deleteAxis(engine.sheets, active, "col", box.c1, box.c2 - box.c1 + 1), active);
  }

  function switchSheet(i: number) {
    if (i === active) return;
    commitEdit("none");
    setActive(i);
    setSel(START);
    setGrow({ rows: 0, cols: 0 });
  }

  function onAddSheet() {
    const name = uniqueSheetName(engine.sheets, `${t("sheetBase")} ${engine.sheets.length + 1}`);
    replaceSheets(addSheet(engine.sheets, name), engine.sheets.length);
    setSel(START);
  }

  function onRenameSheet(i: number, name: string) {
    if (/[[\]:*?/\\]/.test(name) || name.length > 31) {
      pushToast({ kind: "error", text: t("tabs.nameInvalid") });
      return;
    }
    if (engine.sheets.some((s, k) => k !== i && s.name.toLowerCase() === name.toLowerCase())) {
      pushToast({ kind: "error", text: t("tabs.nameTaken") });
      return;
    }
    replaceSheets(renameSheet(engine.sheets, i, name), active);
  }

  async function onDeleteSheet(i: number) {
    if (engine.sheets.length <= 1) return;
    const name = engine.sheets[i]?.name ?? "";
    const ok = await confirm({
      title: t("tabs.deleteTitle"),
      message: t("tabs.deleteMessage", { name }),
      confirmLabel: t("tabs.delete"),
      danger: true,
    });
    if (!ok) return;
    const next = deleteSheet(engine.sheets, i);
    replaceSheets(next, Math.min(active > i ? active - 1 : active, next.length - 1));
    setSel(START);
  }

  function onMoveSheet(from: number, to: number) {
    const name = engine.sheets[active]?.name;
    const next = moveSheet(engine.sheets, from, to);
    replaceSheets(
      next,
      Math.max(
        0,
        next.findIndex((s) => s.name === name),
      ),
    );
  }

  // ---------- Tri / filtre ----------

  function sortSelection(ascending: boolean) {
    if (readOnly) return;
    let b: RangeBox = box;
    if (box.r1 === box.r2 && box.c1 === box.c2) {
      b = { r1: 0, c1: 0, r2: Math.max(0, used.rows - 1), c2: Math.max(0, used.cols - 1) };
    }
    const keyCol = Math.max(b.c1, Math.min(b.c2, sel.anchor.c));
    apply(sortChanges(sheet.rows, active, b, keyCol, ascending, header));
  }

  function toggleFilter() {
    setFilters((f) => ({
      ...f,
      [active]: { ...(f[active] ?? NO_FILTER), enabled: !(f[active]?.enabled ?? false) },
    }));
  }

  // ---------- Export CSV ----------

  async function exportCsv() {
    try {
      commitEdit("none");
      const name = engine.sheets[active]?.name ?? "sheet";
      const dest = await saveDialog({
        defaultPath: `${name}.csv`,
        filters: [{ name: "CSV / TSV", extensions: ["csv", "tsv"] }],
      });
      if (dest === null) return;
      const current = csvRef.current;
      const delimiter = dest.toLowerCase().endsWith(".tsv")
        ? "\t"
        : current && current.delimiter !== "\t"
          ? current.delimiter
          : ",";
      await commands.sheetExportCsv(
        buildWorkbook(engine.sheets, current, undefined),
        active,
        dest,
        delimiter,
      );
      pushToast({ kind: "success", text: t("export.done", { name: basename(dest) }) });
    } catch (e) {
      reportError(e);
    }
  }

  // ---------- Souris ----------

  function onMouseDownCell(pos: Pos, e: MouseEvent) {
    if (editingRef.current) commitEdit("none");
    select(pos, e.shiftKey);
    gridApi.current?.focus();
  }

  function onHeader(kind: "row" | "col", index: number, e: MouseEvent) {
    if (e.button !== 0) return;
    if (editingRef.current) commitEdit("none");
    if (kind === "row") {
      const next = { r: index, c: colCount - 1 };
      setSel((s) =>
        e.shiftKey
          ? { anchor: s.anchor, focus: next }
          : { anchor: { r: index, c: 0 }, focus: next },
      );
    } else {
      const next = { r: rowCount - 1, c: index };
      setSel((s) =>
        e.shiftKey
          ? { anchor: s.anchor, focus: next }
          : { anchor: { r: 0, c: index }, focus: next },
      );
    }
    gridApi.current?.focus();
  }

  function onResize(col: number, px: number) {
    if (readOnly) return;
    engine.setColWidth(active, col, Math.round((Math.max(MIN_COL_PX, px) / CHAR_PX) * 100) / 100);
    setDirty(true);
    bump();
  }

  function onContextMenu(target: { kind: MenuKind; r: number; c: number }, e: MouseEvent) {
    e.preventDefault();
    if (editingRef.current) commitEdit("none");
    const inside =
      target.r >= box.r1 && target.r <= box.r2 && target.c >= box.c1 && target.c <= box.c2;
    if (target.kind === "cell" && !inside) select({ r: target.r, c: target.c });
    if (target.kind === "row" && !(target.r >= box.r1 && target.r <= box.r2)) {
      setSel({ anchor: { r: target.r, c: 0 }, focus: { r: target.r, c: colCount - 1 } });
    }
    if (target.kind === "col" && !(target.c >= box.c1 && target.c <= box.c2)) {
      setSel({ anchor: { r: 0, c: target.c }, focus: { r: rowCount - 1, c: target.c } });
    }
    setMenu({ x: e.clientX, y: e.clientY, kind: target.kind });
  }

  // ---------- Intégration au shell ----------

  useEffect(() => {
    actions.current = {
      undo: () => undoRedo("undo"),
      redo: () => undoRedo("redo"),
      fillDown,
      exportCsv: () => void exportCsv(),
      sortAsc: () => sortSelection(true),
      sortDesc: () => sortSelection(false),
      filter: toggleFilter,
      insertRow: () => insertRows(false),
      deleteRow: deleteRows,
      insertCol: () => insertCols(false),
      deleteCol: deleteCols,
      addSheet: onAddSheet,
      copy: () => void copySelection(false),
      cut: () => void copySelection(true),
      paste: () => void pasteClipboard(),
      clear: clearSelection,
      rowAbove: () => insertRows(false),
      rowBelow: () => insertRows(true),
      colLeft: () => insertCols(false),
      colRight: () => insertCols(true),
    };
  });

  useEffect(() => {
    registerSerializer(() => {
      if (editingRef.current) commitEdit("none");
      return buildWorkbook(engine.sheets, csvRef.current, model.lossy);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerSerializer, engine, model.lossy]);

  useEffect(() => {
    const run = (name: string) => () => actions.current[name]?.();
    registerCommands([
      { id: "sheet.undo", title: t("commands.undo"), shortcut: "Mod+Z", run: run("undo") },
      { id: "sheet.redo", title: t("commands.redo"), shortcut: "Mod+Shift+Z", run: run("redo") },
      { id: "sheet.redoAlt", title: t("commands.redo"), shortcut: "Mod+Y", run: run("redo") },
      {
        id: "sheet.fillDown",
        title: t("commands.fillDown"),
        shortcut: "Mod+D",
        run: run("fillDown"),
      },
      { id: "sheet.exportCsv", title: t("commands.exportCsv"), run: run("exportCsv") },
      { id: "sheet.sortAsc", title: t("commands.sortAsc"), run: run("sortAsc") },
      { id: "sheet.sortDesc", title: t("commands.sortDesc"), run: run("sortDesc") },
      { id: "sheet.filter", title: t("commands.filter"), run: run("filter") },
      { id: "sheet.insertRow", title: t("commands.insertRow"), run: run("insertRow") },
      { id: "sheet.deleteRow", title: t("commands.deleteRow"), run: run("deleteRow") },
      { id: "sheet.insertCol", title: t("commands.insertCol"), run: run("insertCol") },
      { id: "sheet.deleteCol", title: t("commands.deleteCol"), run: run("deleteCol") },
      { id: "sheet.addSheet", title: t("commands.addSheet"), run: run("addSheet") },
    ]);
  }, [registerCommands, t]);

  // Barre d'état
  useEffect(() => {
    const items = [{ id: "sheet.ref", text: rangeName(box) }];
    if (box.r1 !== box.r2 || box.c1 !== box.c2) {
      let sum = 0;
      let nums = 0;
      let count = 0;
      const r2 = Math.min(box.r2, sheet.rows.length - 1);
      for (let r = box.r1; r <= r2; r++) {
        const row = sheet.rows[r];
        if (!row) continue;
        const c2 = Math.min(box.c2, row.length - 1);
        for (let c = box.c1; c <= c2; c++) {
          const cell = row[c];
          if (!cell || cell.v.type === "empty") continue;
          count++;
          const v = cellToScalar(cell.v);
          if (typeof v === "number") {
            sum += v;
            nums++;
          }
        }
      }
      const fmt = (n: number) => formatNumber(n, null, locale);
      items.push({
        id: "sheet.stats",
        text:
          nums > 0
            ? t("status.stats", { sum: fmt(sum), avg: fmt(sum / nums), count })
            : t("status.count", { count }),
      });
    }
    if (model.lossy && model.lossy.length > 0) {
      items.push({ id: "sheet.lossy", text: t("status.lossy", { count: model.lossy.length }) });
    }
    if (readOnly) items.push({ id: "sheet.readOnly", text: t("readOnly") });
    setStatus(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, version, active, locale, readOnly, t, setStatus]);

  const sheetSummaries = useMemo(
    () =>
      engine.sheets.map((s) => {
        const u = usedExtent(s.rows);
        return { name: s.name, rows: u.rows, cols: u.cols };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, version],
  );

  const activeCell = cellAt(sel.anchor.r, sel.anchor.c);
  const barContent = editing ? editing.text : cellInputText(activeCell, locale);

  function gotoReference(text: string) {
    const range = parseRangeText(text);
    if (!range) {
      pushToast({ kind: "error", text: t("formulaBar.invalidReference", { text }) });
      return;
    }
    setGrow((g) => ({
      rows: Math.max(g.rows, range.r2 + 30),
      cols: Math.max(g.cols, range.c2 + 6),
    }));
    setSel({ anchor: { r: range.r1, c: range.c1 }, focus: { r: range.r2, c: range.c2 } });
    gridApi.current?.focus();
  }

  return (
    <div className={styles.root}>
      <EditorToolbar>
        <SheetToolbar
          readOnly={readOnly}
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          header={header}
          filterOn={filter.enabled}
          onUndo={() => undoRedo("undo")}
          onRedo={() => undoRedo("redo")}
          onFormat={applyFormat}
          onDecimals={changeDecimalsOfSelection}
          onSort={sortSelection}
          onToggleHeader={() => setHeader((h) => !h)}
          onToggleFilter={toggleFilter}
        />
      </EditorToolbar>
      <EditorSidePanel title={t("panel.title")}>
        <SheetPanel
          sheets={sheetSummaries}
          active={active}
          csv={csv}
          lossy={model.lossy ?? []}
          readOnly={readOnly}
          onSelect={switchSheet}
          onCsvChange={(next) => {
            setCsv(next);
            setDirty(true);
          }}
        />
      </EditorSidePanel>

      <FormulaBar
        reference={rangeName(
          normalizeRange({
            r1: sel.anchor.r,
            c1: sel.anchor.c,
            r2: sel.anchor.r,
            c2: sel.anchor.c,
          }),
        )}
        content={barContent}
        readOnly={readOnly}
        onGoto={gotoReference}
        onContentFocus={() => {
          if (!editingRef.current) startEdit("edit", undefined, "bar");
        }}
        onContentChange={(text) => {
          const ed = editingRef.current;
          if (ed) setEditing({ ...ed, text });
        }}
        onContentKeyDown={onEditKeyDown}
      />
      <div className={styles.main}>
        <Grid
          rows={sheet.rows}
          version={version}
          rowCount={rowCount}
          colCount={colCount}
          rowOrder={rowOrder}
          colWidths={sheet.colWidths}
          defaultColPx={DEFAULT_COL_PX}
          charPx={CHAR_PX}
          sel={sel}
          editing={editing}
          locale={locale}
          filter={filter}
          dataCols={used.cols}
          apiRef={gridApi}
          label={t("grid.label")}
          filterLabel={t("filter.button")}
          onMouseDownCell={onMouseDownCell}
          onDragCell={(pos) => select(pos, true)}
          onDoubleClickCell={(pos) => {
            select(pos);
            startEdit("edit", undefined, "cell", pos);
          }}
          onHeader={onHeader}
          onResize={onResize}
          onContextMenu={onContextMenu}
          onFilterButton={(col, rect) => setFilterPop({ col, rect })}
          onEditChange={(text) => {
            const ed = editingRef.current;
            if (ed) setEditing({ ...ed, text });
          }}
          onEditKeyDown={onEditKeyDown}
          onKeyDown={onGridKeyDown}
        />
      </div>
      <SheetTabs
        names={engine.sheets.map((s) => s.name)}
        active={active}
        readOnly={readOnly}
        onSelect={switchSheet}
        onAdd={onAddSheet}
        onRename={onRenameSheet}
        onDelete={(i) => void onDeleteSheet(i)}
        onMove={onMoveSheet}
      />
      {menu && (
        <SheetContextMenu
          x={menu.x}
          y={menu.y}
          kind={menu.kind}
          readOnly={readOnly}
          onAction={(id) => actions.current[id]?.()}
          onClose={() => {
            setMenu(null);
            gridApi.current?.focus();
          }}
        />
      )}
      {filterPop && (
        <FilterPopup
          anchor={filterPop.rect}
          values={uniqueValues(sheet.rows, filterPop.col, display)}
          excluded={filter.excluded[filterPop.col] ?? []}
          onClose={() => setFilterPop(null)}
          onApply={(excluded) => {
            setFilters((f) => {
              const cur = f[active] ?? NO_FILTER;
              return {
                ...f,
                [active]: { ...cur, excluded: { ...cur.excluded, [filterPop.col]: excluded } },
              };
            });
            setFilterPop(null);
          }}
        />
      )}
    </div>
  );
}
