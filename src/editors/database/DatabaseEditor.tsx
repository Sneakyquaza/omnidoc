import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../../ipc/bindings";
import type { DbDoc, DbResult, DbSchemaEntry, DbTable, DbValue } from "../../ipc/bindings";
import { basename } from "../../shell/paths";
import { reportError } from "../../shell/errors";
import { EditorSidePanel, EditorToolbar } from "../../shell/slots";
import { Button } from "../../shell/ui/Button";
import { pushToast } from "../../shell/ui/toastStore";
import type { EditorProps } from "../types";
import { DataGrid } from "./DataGrid";
import { BLOCK_SIZE, blockOf, rowCountLabel } from "./logic";
import styles from "./DatabaseEditor.module.css";

type View = "data" | "query" | "schema";
const QUERY_LIMIT = 1000;

function TableData({ path, table, label }: { path: string; table: DbTable; label: string }) {
  const { t } = useTranslation("database");
  const [blocks] = useState(() => new Map<number, DbValue[][]>());
  const [pending] = useState(() => new Set<number>());
  const [, setVersion] = useState(0);
  const [total, setTotal] = useState(table.rowCountExact === false ? 0 : table.rowCount);

  const loadBlock = useCallback(
    (b: number) => {
      if (blocks.has(b) || pending.has(b)) return;
      pending.add(b);
      commands
        .dbRows(path, table.name, b * BLOCK_SIZE, BLOCK_SIZE)
        .then((res) => {
          blocks.set(b, res.rows);
          if (res.total !== null) setTotal(res.total);
          else if (res.rows.length < BLOCK_SIZE) setTotal(b * BLOCK_SIZE + res.rows.length);
          else setTotal((prev) => Math.max(prev, (b + 1) * BLOCK_SIZE + 1));
          setVersion((v) => v + 1);
        })
        .catch(reportError)
        .finally(() => pending.delete(b));
    },
    [path, table.name, blocks, pending],
  );

  useEffect(() => {
    loadBlock(0);
  }, [loadBlock]);

  const getRow = (i: number) => blocks.get(blockOf(i))?.[i % BLOCK_SIZE];
  const onVisible = useCallback((i: number) => loadBlock(blockOf(i)), [loadBlock]);

  if (total === 0 && blocks.has(0)) return <p className={styles.empty}>{t("data.empty")}</p>;
  return (
    <DataGrid
      label={label}
      columns={table.columns}
      total={total}
      getRow={getRow}
      onVisible={onVisible}
    />
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

function SchemaPane({ path, active }: { path: string; active: boolean }) {
  const { t } = useTranslation("database");
  const [entries, setEntries] = useState<DbSchemaEntry[] | null>(null);
  useEffect(() => {
    if (!active || entries) return;
    commands.dbSchema(path).then(setEntries).catch(reportError);
  }, [active, entries, path]);
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

export default function DatabaseEditor({
  tab,
  model,
  registerCommands,
  setStatus,
}: EditorProps<DbDoc>) {
  const { t } = useTranslation("database");
  const path = tab.path;
  const [view, setView] = useState<View>("data");
  const [selected, setSelected] = useState(model.tables[0]?.name ?? null);
  const table = model.tables.find((x) => x.name === selected) ?? null;

  const exportCsv = useCallback(async () => {
    if (!path || !table) return;
    try {
      const dest = await saveDialog({
        defaultPath: `${table.name}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (dest === null) return;
      await commands.dbExportCsv(path, table.name, dest);
      pushToast({ kind: "success", text: t("export.done", { name: basename(dest) }) });
    } catch (e) {
      reportError(e);
    }
  }, [path, table, t]);

  useEffect(() => {
    registerCommands([
      { id: "database.data", title: t("commands.data"), run: () => setView("data") },
      { id: "database.query", title: t("commands.query"), run: () => setView("query") },
      { id: "database.schema", title: t("commands.schema"), run: () => setView("schema") },
      { id: "database.exportCsv", title: t("commands.exportCsv"), run: () => void exportCsv() },
    ]);
  }, [registerCommands, t, exportCsv]);

  useEffect(() => {
    setStatus([
      { id: "database.tables", text: t("status.tables", { count: model.tables.length }) },
      ...(table
        ? [
            {
              id: "database.table",
              text: t("status.table", { name: table.name, count: rowCountLabel(table) }),
            },
          ]
        : []),
    ]);
  }, [setStatus, t, model.tables.length, table]);

  const tabs: View[] = ["data", "query", "schema"];
  return (
    <div className={styles.root}>
      <EditorToolbar>
        <Button icon="export" onClick={() => void exportCsv()} disabled={!table || !path}>
          {t("export.csv")}
        </Button>
      </EditorToolbar>
      <EditorSidePanel title={t("sidebar.title")} side="left">
        {model.tables.length === 0 ? <p className={styles.empty}>{t("sidebar.empty")}</p> : null}
        <ul className={styles.list}>
          {model.tables.map((x) => (
            <li key={x.name}>
              <button
                type="button"
                className={styles.listButton}
                aria-current={x.name === selected}
                onClick={() => {
                  setSelected(x.name);
                  setView("data");
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
      {path === null ? (
        <p className={styles.empty}>{t("noPath")}</p>
      ) : (
        <>
          <div className={styles.body} hidden={view !== "data"}>
            {table ? (
              <TableData key={table.name} path={path} table={table} label={table.name} />
            ) : (
              <p className={styles.empty}>{t("sidebar.empty")}</p>
            )}
          </div>
          <QueryPane path={path} active={view === "query"} />
          <SchemaPane path={path} active={view === "schema"} />
        </>
      )}
    </div>
  );
}
