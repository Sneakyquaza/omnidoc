import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../../ipc/bindings";
import type {
  DbDoc,
  DbColumnDef,
  DbEditOp,
  DbEditResult,
  DbEditSession,
  DbInput,
  DbInt,
  DbResult,
  DbSchemaEntry,
  DbTable,
  DbValue,
} from "../../ipc/bindings";
import { basename } from "../../shell/paths";
import { reportError } from "../../shell/errors";
import { EditorSidePanel, EditorToolbar } from "../../shell/slots";
import { Button } from "../../shell/ui/Button";
import { confirm } from "../../shell/ui/dialogStore";
import type { MenuItem } from "../../shell/ui/Menu";
import { ToolBar, ToolGroup } from "../../shell/ui/ToolBar";
import { pushToast } from "../../shell/ui/toastStore";
import type { EditorProps } from "../types";
import { ContextMenu } from "../pdf/ContextMenu";
import { DataGrid } from "./DataGrid";
import { AddColumnDialog, InsertRowDialog, NameDialog, NewTableDialog } from "./EditDialogs";
import { BLOCK_SIZE, blockOf, inputFor, isEditableValue, rowCountLabel } from "./logic";
import styles from "./DatabaseEditor.module.css";

type View = "data" | "query" | "schema";
const QUERY_LIMIT = 1000;

interface Block {
  rows: DbValue[][];
  rowids: DbInt[] | null;
}

/** Résultat d'une opération d'édition (chemin de la copie de travail à relire ensuite). */
type RunEdit = (op: DbEditOp) => Promise<{ res: DbEditResult; workPath: string } | null>;

type Dialog = { kind: "insert" } | { kind: "addColumn" } | { kind: "renameColumn"; column: string };

type GridMenu = { x: number; y: number; col: number; row: number | null };

function TableData({
  path,
  table,
  label,
  canEdit,
  runEdit,
  onChanged,
}: {
  path: string;
  table: DbTable;
  label: string;
  canEdit: boolean;
  runEdit: RunEdit;
  /** Après une modification de lignes ou de colonnes : relire tables et données. */
  onChanged(workPath: string): Promise<void>;
}) {
  const { t } = useTranslation("database");
  const [blocks] = useState(() => new Map<number, Block>());
  const [pending] = useState(() => new Set<number>());
  const [, setVersion] = useState(0);
  const [total, setTotal] = useState(table.rowCountExact === false ? 0 : table.rowCount);
  const [selected, setSelected] = useState<number[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<GridMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const fetchBlock = useCallback(
    async (b: number, from: string) => {
      const res = await commands.dbRows(from, table.name, b * BLOCK_SIZE, BLOCK_SIZE);
      const block = { rows: res.rows, rowids: res.rowids };
      blocks.set(b, block);
      return { res, block };
    },
    [table.name, blocks],
  );

  const loadBlock = useCallback(
    (b: number) => {
      if (blocks.has(b) || pending.has(b)) return;
      pending.add(b);
      fetchBlock(b, path)
        .then(({ res }) => {
          if (res.total !== null) setTotal(res.total);
          else if (res.rows.length < BLOCK_SIZE) setTotal(b * BLOCK_SIZE + res.rows.length);
          else setTotal((prev) => Math.max(prev, (b + 1) * BLOCK_SIZE + 1));
          setVersion((v) => v + 1);
        })
        .catch(reportError)
        .finally(() => pending.delete(b));
    },
    [path, blocks, pending, fetchBlock],
  );

  useEffect(() => {
    loadBlock(0);
  }, [loadBlock]);

  const getRow = (i: number) => blocks.get(blockOf(i))?.rows[i % BLOCK_SIZE];
  const onVisible = useCallback((i: number) => loadBlock(blockOf(i)), [loadBlock]);
  const rowidsKnown = blocks.get(0)?.rowids != null;
  const editable = canEdit && table.editable && rowidsKnown;

  const editCell = async (row: number, col: number, text: string | null) => {
    const rowid = blocks.get(blockOf(row))?.rowids?.[row % BLOCK_SIZE];
    const column = table.columns[col];
    if (rowid === undefined || !column) return;
    const value: DbInput = text === null ? { type: "null" } : inputFor(text, column.type);
    const done = await runEdit({
      op: "updateCell",
      table: table.name,
      rowid,
      column: column.name,
      value,
    });
    if (!done) return;
    try {
      await fetchBlock(blockOf(row), done.workPath);
      setVersion((v) => v + 1);
    } catch (e) {
      reportError(e);
    }
  };

  const deleteRows = async () => {
    if (selected.length === 0) return;
    const ok = await confirm({
      title: t("rows.deleteTitle"),
      message: t("rows.deleteConfirm", { count: selected.length }),
      confirmLabel: t("rows.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      const rowids: DbInt[] = [];
      for (const i of selected) {
        const b = blockOf(i);
        const block = blocks.get(b) ?? (await fetchBlock(b, path)).block;
        const id = block.rowids?.[i % BLOCK_SIZE];
        if (id !== undefined) rowids.push(id);
      }
      const done = await runEdit({ op: "deleteRows", table: table.name, rowids });
      if (done) await onChanged(done.workPath);
    } catch (e) {
      reportError(e);
    }
  };

  const structural = async (op: DbEditOp) => {
    setDialog(null);
    const done = await runEdit(op);
    if (done) await onChanged(done.workPath);
  };

  const gridMenuItems = (m: GridMenu): MenuItem[] => {
    const column = table.columns[m.col];
    if (!column) return [];
    if (m.row === null) {
      return [
        {
          id: "renameColumn",
          label: t("column.rename"),
          onSelect: () => setDialog({ kind: "renameColumn", column: column.name }),
        },
        {
          id: "dropColumn",
          label: t("column.drop"),
          onSelect: () => {
            void confirm({
              title: t("column.dropTitle"),
              message: t("column.dropConfirm", { name: column.name }),
              confirmLabel: t("column.drop"),
              danger: true,
            }).then((ok) => {
              if (ok) void structural({ op: "dropColumn", table: table.name, name: column.name });
            });
          },
        },
        { id: "sep", label: "", separator: true },
        {
          id: "addColumn",
          label: t("column.addMenu"),
          onSelect: () => setDialog({ kind: "addColumn" }),
        },
      ];
    }
    const row = m.row;
    return [
      {
        id: "setNull",
        label: t("edit.setNull"),
        disabled: !isEditableValue(getRow(row)?.[m.col]),
        onSelect: () => void editCell(row, m.col, null),
      },
    ];
  };

  const empty = total === 0 && blocks.has(0);
  const readOnlyHint = table.kind === "view" ? t("edit.readOnlyView") : t("edit.readOnlyNoRowid");
  return (
    <>
      {canEdit && table.editable ? (
        <div className={styles.bar}>
          <Button
            icon="plus"
            onClick={() => setDialog({ kind: "insert" })}
            data-testid="db-add-row"
          >
            {t("rows.add")}
          </Button>
          <Button
            icon="trash"
            onClick={() => void deleteRows()}
            disabled={selected.length === 0}
            data-testid="db-delete-rows"
          >
            {t("rows.deleteButton", { count: selected.length })}
          </Button>
        </div>
      ) : null}
      {empty ? (
        <p className={styles.empty}>{t("data.empty")}</p>
      ) : (
        <DataGrid
          label={label}
          columns={table.columns}
          total={total}
          getRow={getRow}
          onVisible={onVisible}
          editable={editable}
          readOnlyHint={canEdit ? readOnlyHint : undefined}
          onEditCell={editCell}
          onSelectionChange={setSelected}
          onDeleteRows={() => void deleteRows()}
          onContext={editable ? (c) => setMenu(c) : undefined}
        />
      )}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t("edit.menu")}
          items={gridMenuItems(menu)}
          onClose={closeMenu}
        />
      ) : null}
      {dialog?.kind === "insert" ? (
        <InsertRowDialog
          columns={table.columns}
          onCancel={() => setDialog(null)}
          onSubmit={(values) => void structural({ op: "insertRow", table: table.name, values })}
        />
      ) : null}
      {dialog?.kind === "addColumn" ? (
        <AddColumnDialog
          onCancel={() => setDialog(null)}
          onSubmit={(c) =>
            void structural({
              op: "addColumn",
              table: table.name,
              name: c.name,
              colType: c.colType,
              notNull: c.notNull,
              default: c.default,
            })
          }
        />
      ) : null}
      {dialog?.kind === "renameColumn" ? (
        <NameDialog
          title={t("column.renameTitle")}
          label={t("column.name")}
          initial={dialog.column}
          submitLabel={t("column.rename")}
          onCancel={() => setDialog(null)}
          onSubmit={(to) =>
            void structural({ op: "renameColumn", table: table.name, from: dialog.column, to })
          }
        />
      ) : null}
    </>
  );
}

function QueryPane({ path, active }: { path: string; active: boolean }) {
  const { t } = useTranslation("database");
  const [sql, setSql] = useState("SELECT * FROM sqlite_master");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DbResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    const start = performance.now();
    try {
      const res = await commands.dbQuery(path, sql, QUERY_LIMIT);
      setElapsed(performance.now() - start);
      setResult(res);
    } catch (e) {
      setElapsed(performance.now() - start);
      setResult(null);
      const err = e as { code?: string; message?: string };
      setError(err.code === "unsupported" ? t("query.readOnly") : (err.message ?? String(e)));
    } finally {
      setRunning(false);
    }
  }, [path, sql, running, t]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void run();
    }
  }

  const rows = useMemo(() => result?.rows ?? [], [result]);
  const getRow = (i: number) => rows[i];
  return (
    <div className={styles.body} hidden={!active}>
      <textarea
        className={styles.editor}
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        aria-label={t("query.editor")}
        data-testid="db-query-editor"
      />
      <div className={styles.bar}>
        <Button
          variant="primary"
          icon="command"
          onClick={() => void run()}
          disabled={running}
          data-testid="db-query-run"
        >
          {t("query.run")}
        </Button>
        <span className={styles.barInfo} role="status" data-testid="db-query-status">
          {result
            ? t("query.summary", {
                count: rows.length,
                ms: Math.round(elapsed),
              }) +
              (result.total !== null && result.total > rows.length
                ? ` ${t("query.truncated", { limit: QUERY_LIMIT })}`
                : "")
            : t("query.hint")}
        </span>
      </div>
      {error ? (
        <div className={styles.error} role="alert" data-testid="db-query-error">
          {error}
        </div>
      ) : null}
      {result ? (
        <DataGrid
          label={t("query.results")}
          columns={result.columns.map((name) => ({ name }))}
          total={rows.length}
          getRow={getRow}
        />
      ) : null}
    </div>
  );
}

function SchemaPane({ path, active, rev }: { path: string; active: boolean; rev: number }) {
  const { t } = useTranslation("database");
  const [entries, setEntries] = useState<DbSchemaEntry[] | null>(null);
  // `rev` : relecture après une modification de structure.
  useEffect(() => {
    if (!active) return;
    commands.dbSchema(path).then(setEntries).catch(reportError);
  }, [active, path, rev]);
  return (
    <div className={styles.schema} hidden={!active}>
      {entries?.length === 0 ? <p className={styles.empty}>{t("schema.empty")}</p> : null}
      {entries?.map((e) => (
        <div key={e.name}>
          <h3 className={styles.schemaName}>{e.name}</h3>
          <pre className={styles.schemaSql}>{e.sql}</pre>
        </div>
      ))}
    </div>
  );
}

type TableDialog = { kind: "new" } | { kind: "rename"; name: string };

export default function DatabaseEditor({
  tab,
  model,
  registerCommands,
  setStatus,
  setDirty,
  registerSaveHandler,
  setEditable,
}: EditorProps<DbDoc>) {
  const { t } = useTranslation("database");
  const path = tab.path;
  const [view, setView] = useState<View>("data");
  const [tables, setTables] = useState(model.tables);
  const [selected, setSelected] = useState(model.tables[0]?.name ?? null);
  const [rev, setRev] = useState(0);
  const [workPath, setWorkPath] = useState<string | null>(null);
  const [tableDialog, setTableDialog] = useState<TableDialog | null>(null);
  const [tableMenu, setTableMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  const closeTableMenu = useCallback(() => setTableMenu(null), []);
  const sessionRef = useRef<DbEditSession | null>(null);
  const pendingRef = useRef<Promise<DbEditSession> | null>(null);
  const table = tables.find((x) => x.name === selected) ?? tables[0] ?? null;
  const canEdit = path !== null;
  // Après la première modification, toutes les lectures portent sur la copie de travail.
  const readPath = workPath ?? path;

  const ensureSession = useCallback(async (): Promise<DbEditSession> => {
    if (sessionRef.current) return sessionRef.current;
    if (path === null) throw new Error("no path");
    pendingRef.current ??= commands
      .dbEditBegin(path)
      .then((s) => {
        sessionRef.current = s;
        setWorkPath(s.workPath);
        return s;
      })
      .catch((e: unknown) => {
        pendingRef.current = null;
        throw e;
      });
    return pendingRef.current;
  }, [path]);

  const runEdit = useCallback<RunEdit>(
    async (op) => {
      try {
        const s = await ensureSession();
        const res = await commands.dbEdit(s.id, op);
        setDirty(true);
        return { res, workPath: s.workPath };
      } catch (e) {
        reportError(e);
        return null;
      }
    },
    [ensureSession, setDirty],
  );

  /** Relit les tables (compteurs, colonnes) et recharge les données et le schéma. */
  const onChanged = useCallback(async (wp: string, select?: string) => {
    try {
      const doc = await commands.dbTables(wp);
      setTables(doc.tables);
      if (select !== undefined) setSelected(select);
      setRev((r) => r + 1);
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(
    () => () => {
      const s = sessionRef.current;
      if (s) void commands.dbEditDiscard(s.id);
      else void pendingRef.current?.then((p) => commands.dbEditDiscard(p.id));
    },
    [],
  );

  const save = useCallback(async (): Promise<boolean> => {
    const s = sessionRef.current;
    if (!s) return true;
    try {
      await commands.dbEditCommit(s.id);
      setDirty(false);
      pushToast({ kind: "success", text: t("save.done", { name: basename(path ?? "") }) });
      return true;
    } catch (e) {
      reportError(e);
      return false;
    }
  }, [path, setDirty, t]);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    if (path === null) return;
    registerSaveHandler({ save: () => saveRef.current() });
    setEditable(true);
  }, [path, registerSaveHandler, setEditable]);

  const createTable = async (name: string, columns: DbColumnDef[]) => {
    setTableDialog(null);
    const done = await runEdit({ op: "createTable", name, columns });
    if (done) {
      setView("data");
      await onChanged(done.workPath, name);
    }
  };
  const renameTable = async (from: string, to: string) => {
    setTableDialog(null);
    const done = await runEdit({ op: "renameTable", from, to });
    if (done) await onChanged(done.workPath, selected === from ? to : (selected ?? undefined));
  };
  const dropTable = async (name: string) => {
    const ok = await confirm({
      title: t("table.dropTitle"),
      message: t("table.dropConfirm", { name }),
      confirmLabel: t("table.drop"),
      danger: true,
    });
    if (!ok) return;
    const done = await runEdit({ op: "dropTable", name });
    if (done) await onChanged(done.workPath, selected === name ? "" : (selected ?? undefined));
  };

  const exportCsv = useCallback(async () => {
    if (!readPath || !table) return;
    try {
      const dest = await saveDialog({
        defaultPath: `${table.name}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (dest === null) return;
      await commands.dbExportCsv(readPath, table.name, dest);
      pushToast({ kind: "success", text: t("export.done", { name: basename(dest) }) });
    } catch (e) {
      reportError(e);
    }
  }, [readPath, table, t]);

  useEffect(() => {
    registerCommands([
      { id: "database.data", title: t("commands.data"), run: () => setView("data") },
      { id: "database.query", title: t("commands.query"), run: () => setView("query") },
      { id: "database.schema", title: t("commands.schema"), run: () => setView("schema") },
      { id: "database.exportCsv", title: t("commands.exportCsv"), run: () => void exportCsv() },
      ...(canEdit
        ? [
            {
              id: "database.newTable",
              title: t("commands.newTable"),
              run: () => setTableDialog({ kind: "new" }),
            },
          ]
        : []),
    ]);
  }, [registerCommands, t, exportCsv, canEdit]);

  useEffect(() => {
    setStatus([
      { id: "database.tables", text: t("status.tables", { count: tables.length }) },
      ...(table
        ? [
            {
              id: "database.table",
              text: t("status.table", { name: table.name, count: rowCountLabel(table) }),
            },
          ]
        : []),
    ]);
  }, [setStatus, t, tables.length, table]);

  const tabs: View[] = ["data", "query", "schema"];
  return (
    <div className={styles.root}>
      <EditorToolbar>
        <ToolBar label={t("toolbar.label")}>
          <ToolGroup>
            <Button icon="export" onClick={() => void exportCsv()} disabled={!table || !path}>
              {t("export.csv")}
            </Button>
          </ToolGroup>
        </ToolBar>
      </EditorToolbar>
      <EditorSidePanel title={t("sidebar.title")} side="left">
        {canEdit ? (
          <div className={styles.sideActions}>
            <Button
              icon="plus"
              onClick={() => setTableDialog({ kind: "new" })}
              data-testid="db-new-table"
            >
              {t("table.new")}
            </Button>
          </div>
        ) : null}
        {tables.length === 0 ? <p className={styles.empty}>{t("sidebar.empty")}</p> : null}
        <ul className={styles.list}>
          {tables.map((x) => (
            <li key={x.name}>
              <button
                type="button"
                className={styles.listButton}
                aria-current={x.name === table?.name}
                onClick={() => {
                  setSelected(x.name);
                  setView("data");
                }}
                onContextMenu={(e) => {
                  if (!canEdit || x.kind !== "table") return;
                  e.preventDefault();
                  setTableMenu({ x: e.clientX, y: e.clientY, name: x.name });
                }}
              >
                <span className={styles.listName}>{x.name}</span>
                <span className={styles.listMeta}>
                  {x.kind === "view" ? `${t("sidebar.view")} · ` : ""}
                  {rowCountLabel(x)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {table ? (
          <>
            <h3 className={styles.subTitle}>{t("sidebar.columns")}</h3>
            {table.columns.map((c) => (
              <div key={c.name} className={styles.colItem}>
                <span>{c.name}</span>
                <span className={styles.listMeta}>{c.type}</span>
              </div>
            ))}
          </>
        ) : null}
      </EditorSidePanel>
      <div className={styles.tabs} role="tablist" aria-label={t("tabs.label")}>
        {tabs.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            data-testid={`db-tab-${v}`}
            className={styles.tab}
            aria-selected={view === v}
            onClick={() => setView(v)}
          >
            {t(`tabs.${v}`)}
          </button>
        ))}
      </div>
      {readPath === null ? (
        <p className={styles.empty}>{t("noPath")}</p>
      ) : (
        <>
          <div className={styles.body} hidden={view !== "data"}>
            {table ? (
              <TableData
                key={`${table.name}:${rev}`}
                path={readPath}
                table={table}
                label={table.name}
                canEdit={canEdit}
                runEdit={runEdit}
                onChanged={onChanged}
              />
            ) : (
              <p className={styles.empty}>{t("sidebar.empty")}</p>
            )}
          </div>
          <QueryPane path={readPath} active={view === "query"} />
          <SchemaPane path={readPath} active={view === "schema"} rev={rev} />
        </>
      )}
      {tableMenu ? (
        <ContextMenu
          x={tableMenu.x}
          y={tableMenu.y}
          label={t("table.menu")}
          items={[
            {
              id: "renameTable",
              label: t("table.rename"),
              onSelect: () => setTableDialog({ kind: "rename", name: tableMenu.name }),
            },
            {
              id: "dropTable",
              label: t("table.drop"),
              onSelect: () => void dropTable(tableMenu.name),
            },
          ]}
          onClose={closeTableMenu}
        />
      ) : null}
      {tableDialog?.kind === "new" ? (
        <NewTableDialog
          onCancel={() => setTableDialog(null)}
          onSubmit={(name, columns) => void createTable(name, columns)}
        />
      ) : null}
      {tableDialog?.kind === "rename" ? (
        <NameDialog
          title={t("table.renameTitle")}
          label={t("table.name")}
          initial={tableDialog.name}
          submitLabel={t("table.rename")}
          onCancel={() => setTableDialog(null)}
          onSubmit={(to) => void renameTable(tableDialog.name, to)}
        />
      ) : null}
    </div>
  );
}
