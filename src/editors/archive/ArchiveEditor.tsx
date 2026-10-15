import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../../ipc/bindings";
import type { ArchiveDoc, ArchiveEntry } from "../../ipc/bindings";
import { openPath } from "../../shell/documents";
import { reportError } from "../../shell/errors";
import { basename } from "../../shell/paths";
import { EditorSidePanel, EditorToolbar } from "../../shell/slots";
import { Button } from "../../shell/ui/Button";
import { choose, confirm } from "../../shell/ui/dialogStore";
import { Icon } from "../../shell/ui/icons";
import { pushToast } from "../../shell/ui/toastStore";
import type { EditorProps } from "../types";
import {
  ancestors,
  breadcrumbs,
  buildTree,
  countFiles,
  filterNodes,
  findNode,
  flattenDirs,
  formatDate,
  formatSize,
  joinPath,
  parentPath,
  ratio,
  sortNodes,
} from "./tree";
import type { SortDir, SortKey, TreeNode } from "./tree";
import styles from "./ArchiveEditor.module.css";

const ROW_HEIGHT = 28;
const COLUMNS: SortKey[] = ["name", "size", "compressed", "ratio", "modified"];

export default function ArchiveEditor({
  tab,
  model,
  registerSerializer,
  registerCommands,
  setStatus,
}: EditorProps<ArchiveDoc>) {
  const { t } = useTranslation("archive");
  const path = tab.path;
  // `tab.readOnly` est toujours vrai ici (capabilities.write = false : l'édition passe par
  // les commandes archive_*), seul `writable` décide.
  const writable = model.writable && path !== null;

  const [entries, setEntries] = useState<ArchiveEntry[]>(model.entries);
  const [dir, setDir] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<{ from: string; value: string } | null>(null);
  const [renameError, setRenameError] = useState("");
  const [busy, setBusy] = useState(false);
  const anchor = useRef(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    registerSerializer(() => ({ ...model, entries }));
  }, [registerSerializer, model, entries]);

  const root = useMemo(() => buildTree(entries), [entries]);
  const dirNode = findNode(root, dir) ?? root;
  const currentDir = dirNode.path;
  const rows = useMemo(
    () => sortNodes(filterNodes(dirNode, filter), sort.key, sort.dir),
    [dirNode, filter, sort],
  );
  const totals = useMemo(() => countFiles(entries), [entries]);
  const dirRows = useMemo(() => {
    const open = new Set(expanded);
    for (const a of ancestors(currentDir)) open.add(a);
    return flattenDirs(root, open);
  }, [root, expanded, currentDir]);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const selectedPaths = useMemo(() => [...selected], [selected]);
  const hasSelection = selected.size > 0;

  useEffect(() => {
    setStatus([
      { id: "archive-entries", text: t("status.entries", { count: entries.length }) },
      {
        id: "archive-size",
        text: t("status.files", { count: totals.files, size: formatSize(totals.size) }),
      },
      { id: "archive-format", text: t("status.format", { format: model.format }) },
      ...(hasSelection
        ? [{ id: "archive-selection", text: t("status.selection", { count: selected.size }) }]
        : []),
    ]);
  }, [setStatus, t, entries.length, totals, model.format, hasSelection, selected.size]);

  function navigate(target: string) {
    setDir(target);
    setSelected(new Set());
    setCursor(0);
    anchor.current = 0;
    setRenaming(null);
    scrollerRef.current?.scrollTo({ top: 0 });
  }

  /** Relit les entrées depuis le disque après une modification. */
  const reload = useCallback(async () => {
    if (path === null) return;
    const doc = await commands.openDocument(path, tab.handlerId);
    if (doc.model.kind === "archive") setEntries(doc.model.entries);
    setSelected(new Set());
    setRenaming(null);
  }, [path, tab.handlerId]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }

  const extract = useCallback(
    async (names: string[] | null) => {
      if (path === null) return;
      const dest = await openDialog({ directory: true, title: t("extract.title") });
      if (typeof dest !== "string") return;
      await run(async () => {
        const count = await commands.archiveExtract(path, names, dest);
        pushToast({ kind: "success", text: t("extract.done", { count }) });
      });
    },
    [path, t],
  );

  const addFiles = useCallback(
    async (directory: boolean) => {
      if (path === null || !writable) return;
      const picked = await openDialog({
        multiple: !directory,
        directory,
        title: t("add.title"),
      });
      if (picked === null) return;
      const files = Array.isArray(picked) ? picked : [picked];
      await run(async () => {
        await commands.archiveAdd(path, files, currentDir);
        await reload();
        pushToast({
          kind: "success",
          text: t("add.done", { dir: currentDir === "" ? t("add.root") : currentDir }),
        });
      });
    },
    [path, writable, currentDir, reload, t],
  );

  const remove = useCallback(async () => {
    if (path === null || !writable || selectedPaths.length === 0) return;
    const ok = await confirm({
      title: t("deleteDialog.title"),
      message: t("deleteDialog.message", { count: selectedPaths.length }),
      confirmLabel: t("deleteDialog.confirm"),
      danger: true,
    });
    if (!ok) return;
    await run(async () => {
      await commands.archiveRemove(path, selectedPaths);
      await reload();
      pushToast({
        kind: "success",
        text: t("deleteDialog.done", { count: selectedPaths.length }),
      });
    });
  }, [path, writable, selectedPaths, reload, t]);

  const startRename = useCallback(() => {
    if (!writable || selectedPaths.length !== 1) return;
    const from = selectedPaths[0];
    if (from === undefined) return;
    setRenameError("");
    setRenaming({ from, value: basename(from) });
    setTimeout(() => renameRef.current?.select(), 0);
  }, [writable, selectedPaths]);

  async function submitRename(e: FormEvent) {
    e.preventDefault();
    if (path === null || renaming === null) return;
    const name = renaming.value.trim();
    if (name === "" || name.includes("/")) {
      setRenameError(t("renameBar.invalid"));
      return;
    }
    const to = joinPath(parentPath(renaming.from), name);
    if (to === renaming.from) {
      setRenaming(null);
      return;
    }
    if (entries.some((en) => en.path.replace(/\/+$/, "") === to)) {
      setRenameError(t("renameBar.exists"));
      return;
    }
    const from = renaming.from;
    await run(async () => {
      await commands.archiveRename(path, from, to);
      await reload();
    });
    scrollerRef.current?.focus();
  }

  const convert = useCallback(async () => {
    if (path === null) return;
    const format = await choose({
      title: t("convertDialog.title"),
      message: t("convertDialog.message"),
      actions: [
        { id: "zip", label: "zip", variant: "primary" },
        { id: "tar", label: "tar", variant: "secondary" },
        { id: "tar.gz", label: "tar.gz", variant: "secondary" },
      ],
    });
    if (format === null) return;
    const base = basename(path).replace(/\.(tar\.gz|tgz|zip|tar|gz|7z)$/i, "");
    const dest = await saveDialog({
      title: t("convertDialog.saveTitle"),
      defaultPath: `${base}.${format}`,
      filters: [{ name: format, extensions: [format === "tar.gz" ? "gz" : format] }],
    });
    if (dest === null) return;
    await run(async () => {
      await commands.archiveConvert(path, dest, format);
      pushToast({ kind: "success", text: t("convertDialog.done", { name: basename(dest) }) });
    });
  }, [path, t]);

  async function openNode(node: TreeNode) {
    if (node.isDir) {
      setFilter("");
      navigate(node.path);
      return;
    }
    if (path === null) return;
    try {
      const tmp = await commands.archiveReadEntry(path, node.path);
      await openPath(tmp);
    } catch (e) {
      reportError(e);
    }
  }

  const extractSelectionOrAll = useCallback(
    () => extract(hasSelection ? selectedPaths : null),
    [extract, hasSelection, selectedPaths],
  );

  useEffect(() => {
    registerCommands([
      {
        id: "archive.extract",
        title: t("commands.extract"),
        shortcut: "Mod+E",
        run: () => void extractSelectionOrAll(),
      },
      { id: "archive.add", title: t("commands.addFiles"), run: () => void addFiles(false) },
      { id: "archive.delete", title: t("commands.delete"), run: () => void remove() },
      { id: "archive.rename", title: t("commands.rename"), run: startRename },
      { id: "archive.convert", title: t("commands.convert"), run: () => void convert() },
    ]);
  }, [registerCommands, t, extractSelectionOrAll, addFiles, remove, startRename, convert]);

  function select(index: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
    const node = rows[index];
    if (!node) return;
    setCursor(index);
    if (e.shiftKey) {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      setSelected(new Set(rows.slice(a, b + 1).map((r) => r.path)));
    } else if (e.ctrlKey || e.metaKey) {
      anchor.current = index;
      const next = new Set(selected);
      if (!next.delete(node.path)) next.add(node.path);
      setSelected(next);
    } else {
      anchor.current = index;
      setSelected(new Set([node.path]));
    }
    virtualizer.scrollToIndex(index, { align: "auto" });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (renaming !== null) return;
    const move = (to: number) => {
      e.preventDefault();
      select(Math.max(0, Math.min(rows.length - 1, to)), e);
    };
    if (e.key === "ArrowDown") move(cursor + 1);
    else if (e.key === "ArrowUp") move(cursor - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(rows.length - 1);
    else if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSelected(new Set(rows.map((r) => r.path)));
    } else if (e.key === "Enter" && rows[cursor]) {
      e.preventDefault();
      void openNode(rows[cursor]);
    } else if (e.key === "Backspace" && currentDir !== "" && filter === "") {
      e.preventDefault();
      navigate(parentPath(currentDir));
    } else if (e.key === "Delete") {
      e.preventDefault();
      void remove();
    } else if (e.key === "F2") {
      e.preventDefault();
      startRename();
    }
  }

  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  }

  function toggleExpanded(p: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(p)) next.add(p);
      return next;
    });
  }

  function onTreeKeyDown(e: KeyboardEvent, row: { node: TreeNode; hasSubdirs: boolean }) {
    const open = expanded.has(row.node.path) || ancestors(currentDir).includes(row.node.path);
    if (e.key === "ArrowRight" && row.hasSubdirs && !open) {
      e.preventDefault();
      toggleExpanded(row.node.path);
    } else if (e.key === "ArrowLeft" && row.hasSubdirs && open) {
      e.preventDefault();
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(row.node.path);
        return next;
      });
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      navigate(row.node.path);
    }
  }

  const writeHint = writable ? undefined : t("readOnlyHint");
  const crumbs = breadcrumbs(currentDir);
  const items = virtualizer.getVirtualItems();

  return (
    <div className={styles.root}>
      <EditorToolbar>
        <div className={styles.toolbar} role="toolbar" aria-label={tab.title}>
          <Button icon="export" disabled={busy} onClick={() => void extractSelectionOrAll()}>
            {hasSelection ? t("actions.extractSelection") : t("actions.extractAll")}
          </Button>
          <Button
            icon="plus"
            disabled={!writable || busy}
            title={writeHint}
            onClick={() => void addFiles(false)}
          >
            {t("actions.addFiles")}
          </Button>
          <Button
            icon="open"
            disabled={!writable || busy}
            title={writeHint}
            onClick={() => void addFiles(true)}
          >
            {t("actions.addFolder")}
          </Button>
          <Button
            icon="close"
            disabled={!writable || !hasSelection || busy}
            title={writeHint}
            onClick={() => void remove()}
          >
            {t("actions.delete")}
          </Button>
          <Button
            disabled={!writable || selected.size !== 1 || busy}
            title={writeHint}
            onClick={startRename}
          >
            {t("actions.rename")} (F2)
          </Button>
          <Button icon="archive" disabled={busy} onClick={() => void convert()}>
            {t("actions.convert")}
          </Button>
        </div>
      </EditorToolbar>

      <EditorSidePanel title={t("tree.title")} side="left">
        <ul className={styles.tree} role="tree" aria-label={t("tree.label")}>
          {dirRows.map((row) => {
            const open =
              row.node.path === "" ||
              expanded.has(row.node.path) ||
              ancestors(currentDir).includes(row.node.path);
            return (
              <li key={row.node.path} role="none">
                <div
                  role="treeitem"
                  tabIndex={0}
                  aria-level={row.depth + 1}
                  aria-selected={row.node.path === currentDir}
                  aria-expanded={row.hasSubdirs ? open : undefined}
                  className={`${styles.treeItem} ${row.node.path === currentDir ? styles.treeCurrent : ""}`}
                  style={{ paddingLeft: 6 + row.depth * 14 }}
                  onClick={() => navigate(row.node.path)}
                  onKeyDown={(e) => onTreeKeyDown(e, row)}
                >
                  <span
                    className={styles.caret}
                    aria-hidden="true"
                    onClick={(e) => {
                      if (!row.hasSubdirs || row.node.path === "") return;
                      e.stopPropagation();
                      toggleExpanded(row.node.path);
                    }}
                  >
                    {row.hasSubdirs && row.node.path !== "" ? (open ? "▾" : "▸") : ""}
                  </span>
                  <span className={styles.treeName}>
                    {row.node.path === "" ? t("tree.root") : row.node.name}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </EditorSidePanel>

      {!writable && (
        <p className={styles.notice} role="note">
          {t("readOnly")}
        </p>
      )}

      <div className={styles.bar}>
        <button
          type="button"
          className={styles.crumb}
          aria-label={t("actions.up")}
          title={t("actions.up")}
          disabled={currentDir === ""}
          onClick={() => navigate(parentPath(currentDir))}
        >
          <Icon name="openAs" />
        </button>
        <nav className={styles.crumbs} aria-label={t("breadcrumb.label")}>
          <button type="button" className={styles.crumb} onClick={() => navigate("")}>
            {t("breadcrumb.root")}
          </button>
          {crumbs.map((c) => (
            <span key={c.path} className={styles.crumbItem}>
              <span aria-hidden="true">/</span>
              <button type="button" className={styles.crumb} onClick={() => navigate(c.path)}>
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        <input
          type="search"
          className={styles.input}
          value={filter}
          aria-label={t("filter.label")}
          placeholder={t("filter.placeholder")}
          onChange={(e) => {
            setFilter(e.target.value);
            setSelected(new Set());
            setCursor(0);
          }}
        />
      </div>

      {renaming !== null && (
        <form className={styles.bar} onSubmit={(e) => void submitRename(e)}>
          <label className={styles.barLabel} htmlFor="archive-rename">
            {t("renameBar.label")}
          </label>
          <input
            id="archive-rename"
            ref={renameRef}
            className={styles.input}
            value={renaming.value}
            onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setRenaming(null);
                scrollerRef.current?.focus();
              }
            }}
          />
          <Button type="submit" variant="primary" disabled={busy}>
            {t("renameBar.apply")}
          </Button>
          {renameError && <span className={styles.error}>{renameError}</span>}
        </form>
      )}

      <div className={`${styles.header} ${styles.cols}`} role="presentation">
        {COLUMNS.map((key) => (
          <button
            key={key}
            type="button"
            className={`${styles.headCell} ${key === "name" ? "" : styles.num}`}
            aria-label={`${t(`columns.${key}`)}${sort.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}`}
            onClick={() => toggleSort(key)}
          >
            {t(`columns.${key}`)}
            {sort.key === key && <span aria-hidden="true">{sort.dir === "asc" ? " ▲" : " ▼"}</span>}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className={styles.empty}>{filter === "" ? t("list.empty") : t("list.noMatch")}</p>
      ) : (
        <div
          ref={scrollerRef}
          className={styles.scroller}
          tabIndex={0}
          role="grid"
          aria-label={t("list.label")}
          aria-rowcount={rows.length}
          aria-multiselectable="true"
          onKeyDown={onKeyDown}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((vi) => {
              const node = rows[vi.index];
              if (!node) return null;
              const isSel = selected.has(node.path);
              const pct = ratio(node.size, node.compressedSize);
              return (
                <div
                  key={node.path}
                  role="row"
                  aria-rowindex={vi.index + 1}
                  aria-selected={isSel}
                  className={`${styles.row} ${styles.cols} ${isSel ? styles.selected : ""} ${vi.index === cursor ? styles.cursor : ""}`}
                  style={{ height: ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
                  onClick={(e: MouseEvent) => select(vi.index, e)}
                  onDoubleClick={() => void openNode(node)}
                >
                  <span role="gridcell" className={styles.name} title={node.path}>
                    <Icon name={node.isDir ? "open" : "file"} />
                    <span className={styles.nameText}>{filter === "" ? node.name : node.path}</span>
                  </span>
                  <span role="gridcell" className={styles.num}>
                    {formatSize(node.size)}
                  </span>
                  <span role="gridcell" className={styles.num}>
                    {node.compressedSize === null ? "" : formatSize(node.compressedSize)}
                  </span>
                  <span role="gridcell" className={styles.num}>
                    {pct === null ? "" : `${pct} %`}
                  </span>
                  <span role="gridcell" className={styles.num}>
                    {formatDate(node.modified)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
