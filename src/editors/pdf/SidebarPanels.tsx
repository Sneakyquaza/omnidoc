import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PdfAnnotation } from "../../ipc/bindings";
import { IconButton } from "../../shell/ui/Button";
import styles from "./SidebarPanels.module.css";

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineNode[];
}

async function destToPage(
  pdf: PDFDocumentProxy,
  dest: OutlineNode["dest"],
): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    const target = explicit?.[0];
    if (target === null || target === undefined) return null;
    if (typeof target === "number") return target + 1;
    return (await pdf.getPageIndex(target as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1;
  } catch {
    return null;
  }
}

function OutlineItems({
  pdf,
  nodes,
  onGoto,
}: {
  pdf: PDFDocumentProxy;
  nodes: OutlineNode[];
  onGoto(page: number): void;
}) {
  return (
    <ul className={styles.tree} role="group">
      {nodes.map((n, i) => (
        <li key={i} role="treeitem" aria-selected="false">
          <button
            type="button"
            className={styles.link}
            onClick={() =>
              void destToPage(pdf, n.dest).then((page) => {
                if (page !== null) onGoto(page);
              })
            }
          >
            {n.title}
          </button>
          {n.items.length > 0 && <OutlineItems pdf={pdf} nodes={n.items} onGoto={onGoto} />}
        </li>
      ))}
    </ul>
  );
}

export function OutlinePanel({
  pdf,
  onGoto,
}: {
  pdf: PDFDocumentProxy;
  onGoto(page: number): void;
}) {
  const { t } = useTranslation("pdf");
  const [outline, setOutline] = useState<OutlineNode[] | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    pdf
      .getOutline()
      .then((o) => {
        if (!cancelled) setOutline(o as OutlineNode[] | null);
      })
      .catch(() => {
        if (!cancelled) setOutline(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pdf]);
  if (outline === undefined) return null;
  if (!outline || outline.length === 0) return <p className={styles.empty}>{t("outline.none")}</p>;
  return (
    <div className={styles.scroller} role="tree" aria-label={t("outline.label")}>
      <OutlineItems pdf={pdf} nodes={outline} onGoto={onGoto} />
    </div>
  );
}

function AnnotationRow({
  a,
  pending,
  onGoto,
  onRemove,
}: {
  a: PdfAnnotation;
  pending?: boolean;
  onGoto(page: number): void;
  onRemove?(): void;
}) {
  const { t } = useTranslation("pdf");
  return (
    <li className={styles.annotation}>
      <button type="button" className={styles.link} onClick={() => onGoto(a.page)}>
        <span className={styles.kind}>
          {t(`annotations.kind.${a.kind}`, { defaultValue: a.kind })}
          {pending ? ` ${t("annotations.pendingTag")}` : ""}
        </span>
        <span className={styles.meta}>{t("annotations.page", { page: a.page })}</span>
        {a.contents && <span className={styles.contents}>{a.contents}</span>}
      </button>
      {onRemove && <IconButton icon="close" label={t("annotations.remove")} onClick={onRemove} />}
    </li>
  );
}

export function AnnotationsPanel({
  existing,
  pending,
  onGoto,
  onRemovePending,
}: {
  existing: PdfAnnotation[];
  pending: PdfAnnotation[];
  onGoto(page: number): void;
  onRemovePending(index: number): void;
}) {
  const { t } = useTranslation("pdf");
  if (existing.length === 0 && pending.length === 0) {
    return <p className={styles.empty}>{t("annotations.none")}</p>;
  }
  return (
    <div className={styles.scroller}>
      <ul className={styles.list} aria-label={t("annotations.label")}>
        {pending.map((a, i) => (
          <AnnotationRow
            key={`p${i}`}
            a={a}
            pending
            onGoto={onGoto}
            onRemove={() => onRemovePending(i)}
          />
        ))}
        {existing.map((a, i) => (
          <AnnotationRow key={`e${i}`} a={a} onGoto={onGoto} />
        ))}
      </ul>
    </div>
  );
}
