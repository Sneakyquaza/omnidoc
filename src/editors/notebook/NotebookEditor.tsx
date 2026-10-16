import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../../ipc/bindings";
import type { DocumentModel, NotebookCell, NotebookDoc, NotebookOutput } from "../../ipc/bindings";
import { reportError } from "../../shell/errors";
import { basename } from "../../shell/paths";
import { EditorSidePanel, EditorToolbar } from "../../shell/slots";
import { Button } from "../../shell/ui/Button";
import { pushToast } from "../../shell/ui/toastStore";
import type { EditorProps } from "../types";
import { extractOutline, isSafeImageUri, renderMarkdown, sanitizeHtml } from "./logic";
import styles from "./NotebookEditor.module.css";

const MarkdownCell = memo(function MarkdownCell({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: html }} />;
});

const HtmlOutput = memo(function HtmlOutput({ html }: { html: string }) {
  const clean = useMemo(() => sanitizeHtml(html), [html]);
  return <div className={styles.htmlOutput} dangerouslySetInnerHTML={{ __html: clean }} />;
});

function Output({ output }: { output: NotebookOutput }) {
  const { t } = useTranslation("notebook");
  const text = output.text ?? output.data ?? "";
  switch (output.kind) {
    case "html":
      return <HtmlOutput html={output.data ?? output.text ?? ""} />;
    case "image": {
      const uri = output.data ?? "";
      return isSafeImageUri(uri) ? (
        <img className={styles.image} src={uri} alt={t("output.image")} />
      ) : null;
    }
    case "error":
      return (
        <pre className={`${styles.pre} ${styles.error}`} role="alert">
          {text}
        </pre>
      );
    default:
      return <pre className={styles.pre}>{text}</pre>;
  }
}

function Cell({ cell, index }: { cell: NotebookCell; index: number }) {
  const { t } = useTranslation("notebook");
  return (
    <section
      id={`nb-cell-${index}`}
      className={styles.cell}
      aria-label={t("cell.label", { n: index + 1 })}
    >
      {cell.cellType === "markdown" ? (
        <MarkdownCell source={cell.source} />
      ) : (
        <>
          {cell.cellType !== "code" ? <div className={styles.cellKind}>{cell.cellType}</div> : null}
          <pre className={styles.code}>
            <code>{cell.source}</code>
          </pre>
          {cell.outputs.length > 0 ? (
            <div className={styles.outputs} aria-label={t("output.label")}>
              {cell.outputs.map((o, i) => (
                <Output key={i} output={o} />
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export default function NotebookEditor({
  tab,
  model,
  registerCommands,
  setStatus,
}: EditorProps<NotebookDoc>) {
  const { t } = useTranslation("notebook");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const outline = useMemo(() => extractOutline(model.cells), [model.cells]);

  useEffect(() => {
    const codeCells = model.cells.filter((c) => c.cellType === "code").length;
    setStatus([
      { id: "notebook.cells", text: t("status.cells", { count: model.cells.length }) },
      { id: "notebook.code", text: t("status.code", { count: codeCells }) },
      ...(model.language ? [{ id: "notebook.lang", text: model.language }] : []),
    ]);
  }, [setStatus, t, model]);

  const exportAs = useCallback(
    async (target: "md" | "html") => {
      try {
        const dest = await saveDialog({
          defaultPath: tab.path
            ? `${basename(tab.path).replace(/\.[^.]+$/, "")}.${target}`
            : `${tab.title}.${target}`,
          filters: [
            target === "md"
              ? { name: "Markdown", extensions: ["md"] }
              : { name: "HTML", extensions: ["html"] },
          ],
        });
        if (dest === null) return;
        const doc: DocumentModel = { ...model, kind: "notebook" };
        await commands.exportDocument(doc, tab.handlerId, target, dest);
        pushToast({ kind: "success", text: t("export.done", { name: basename(dest) }) });
      } catch (e) {
        reportError(e);
      }
    },
    [model, tab.handlerId, tab.path, tab.title, t],
  );

  useEffect(() => {
    registerCommands([
      {
        id: "notebook.exportMd",
        title: t("commands.exportMd"),
        run: () => void exportAs("md"),
      },
      {
        id: "notebook.exportHtml",
        title: t("commands.exportHtml"),
        run: () => void exportAs("html"),
      },
    ]);
  }, [registerCommands, t, exportAs]);

  function goto(cell: number) {
    scrollerRef.current
      ?.querySelector(`#nb-cell-${cell}`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  // Les liens du contenu ne sont jamais suivis (pas de navigation dans l'application).
  function onClick(e: React.MouseEvent) {
    if ((e.target as Element).closest("a")) e.preventDefault();
  }

  return (
    <div className={styles.root}>
      <EditorToolbar>
        <Button icon="export" onClick={() => void exportAs("md")}>
          {t("export.md")}
        </Button>
        <Button icon="export" onClick={() => void exportAs("html")}>
          {t("export.html")}
        </Button>
      </EditorToolbar>
      <EditorSidePanel title={t("outline.title")} side="left">
        {outline.length === 0 ? <p className={styles.muted}>{t("outline.empty")}</p> : null}
        <ul className={styles.outline}>
          {outline.map((o, i) => (
            <li key={i} style={{ paddingLeft: (o.level - 1) * 12 }}>
              <button type="button" className={styles.outlineButton} onClick={() => goto(o.cell)}>
                {o.text}
              </button>
            </li>
          ))}
        </ul>
      </EditorSidePanel>
      <div
        className={styles.scroller}
        ref={scrollerRef}
        onClick={onClick}
        tabIndex={0}
        role="document"
        aria-label={t("document")}
      >
        {model.cells.length === 0 ? <p className={styles.muted}>{t("empty")}</p> : null}
        {model.cells.map((c, i) => (
          <Cell key={i} cell={c} index={i} />
        ))}
      </div>
    </div>
  );
}
