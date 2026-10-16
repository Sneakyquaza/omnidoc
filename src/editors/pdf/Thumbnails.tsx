import { useEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { DEFAULT_PAGE } from "./usePdfDocument";
import type { PageInfo } from "./usePdfDocument";
import styles from "./Thumbnails.module.css";

const THUMB_WIDTH = 120;
const LABEL_HEIGHT = 26;

function thumbSize(info: PageInfo): { width: number; height: number } {
  const w = info.view[2] - info.view[0];
  const h = info.view[3] - info.view[1];
  const sideways = info.rotate % 180 !== 0;
  const [pw, ph] = sideways ? [h, w] : [w, h];
  return { width: THUMB_WIDTH, height: Math.round((THUMB_WIDTH * ph) / pw) };
}

function ThumbCanvas({
  pdf,
  pageNumber,
  info,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  info: PageInfo;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { width, height } = thumbSize(info);
  useEffect(() => {
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      const canvas = ref.current;
      if (cancelled || !canvas) return;
      const base = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (THUMB_WIDTH * dpr) / base.width });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const render = page.render({ canvas, viewport });
      task = render;
      await render.promise;
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber]);
  return <canvas ref={ref} className={styles.canvas} style={{ width, height }} />;
}

interface Props {
  pdf: PDFDocumentProxy;
  infos: (PageInfo | null)[];
  selected: number[];
  current: number;
  onSelect(page: number, mods: { ctrl: boolean; shift: boolean }): void;
  onContextMenu(e: MouseEvent, page: number): void;
  /** Déplacement par glisser-déposer : pages déplacées, inséré avant la page d'origine `insertBefore`. */
  onDropReorder(pages: number[], insertBefore: number): void;
}

export function Thumbnails({
  pdf,
  infos,
  selected,
  current,
  onSelect,
  onContextMenu,
  onDropReorder,
}: Props) {
  const { t } = useTranslation("pdf");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number[]>([]);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const count = pdf.numPages;
  const infoOf = (i: number) => infos[i] ?? infos[0] ?? DEFAULT_PAGE;

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (i) => thumbSize(infoOf(i)).height + LABEL_HEIGHT + 12,
    overscan: 3,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [infos, virtualizer]);

  useEffect(() => {
    virtualizer.scrollToIndex(current - 1, { align: "auto" });
  }, [current, virtualizer]);

  function onDragStart(e: DragEvent, page: number) {
    const pages = selected.includes(page) ? selected : [page];
    if (!selected.includes(page)) onSelect(page, { ctrl: false, shift: false });
    dragging.current = pages;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", pages.join(","));
  }

  function onDragOver(e: DragEvent, page: number) {
    if (dragging.current.length === 0) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    setDropAt(e.clientY < box.top + box.height / 2 ? page : page + 1);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    const at = dropAt;
    const pages = dragging.current;
    dragging.current = [];
    setDropAt(null);
    if (at !== null && pages.length > 0) onDropReorder(pages, at);
  }

  function onKeyDown(e: KeyboardEvent, page: number) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(page, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(1, Math.min(count, page + (e.key === "ArrowDown" ? 1 : -1)));
      onSelect(next, { ctrl: false, shift: e.shiftKey });
      virtualizer.scrollToIndex(next - 1);
      setTimeout(
        () => scrollerRef.current?.querySelector<HTMLElement>(`[data-thumb="${next}"]`)?.focus(),
        0,
      );
    }
  }

  return (
    <div
      ref={scrollerRef}
      className={styles.scroller}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
      }}
      onDrop={onDrop}
    >
      <div
        className={styles.inner}
        style={{ height: virtualizer.getTotalSize() }}
        role="listbox"
        aria-multiselectable="true"
        aria-label={t("thumbnails.label")}
      >
        {virtualizer.getVirtualItems().map((v) => {
          const page = v.index + 1;
          const isSelected = selected.includes(page);
          return (
            <div
              key={v.key}
              data-index={v.index}
              data-thumb={page}
              role="option"
              tabIndex={page === current ? 0 : -1}
              aria-selected={isSelected}
              aria-label={t("thumbnails.page", { page })}
              draggable
              className={`${styles.item} ${isSelected ? styles.selected : ""}`}
              data-drop={
                dropAt === page
                  ? "before"
                  : dropAt === page + 1 && page === count
                    ? "after"
                    : undefined
              }
              style={{ transform: `translateY(${v.start}px)`, height: v.size }}
              onClick={(e) => onSelect(page, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu(e, page);
              }}
              onKeyDown={(e) => onKeyDown(e, page)}
              onDragStart={(e) => onDragStart(e, page)}
              onDragEnd={() => {
                dragging.current = [];
                setDropAt(null);
              }}
              onDragOver={(e) => onDragOver(e, page)}
            >
              <ThumbCanvas pdf={pdf} pageNumber={page} info={infoOf(v.index)} />
              <span className={styles.label}>{page}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
