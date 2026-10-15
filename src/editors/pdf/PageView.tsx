import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { RenderingCancelledException, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import type { PdfAnnotation } from "../../ipc/bindings";
import { toViewport, viewportSize } from "./geometry";
import type { PageGeometry, ViewRect } from "./geometry";
import type { TextMatch } from "./search";
import styles from "./PageView.module.css";

export type Tool = "select" | "highlight" | "note" | "freeText" | "ink";

/** Geste de dessin terminé, en pixels du viewport de la page. */
export type Draft =
  | { kind: "note"; point: [number, number] }
  | { kind: "freeText"; rect: ViewRect }
  | { kind: "ink"; points: [number, number][] };

interface Props {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  geometry: PageGeometry;
  tool: Tool;
  strokeColor: string;
  pending: PdfAnnotation[];
  matches: TextMatch[];
  currentMatch: number | null;
  onDraft(page: number, draft: Draft): void;
}

const FREE_TEXT_FONT = 12;

function rgb(c: PdfAnnotation["color"]): string {
  const v = (n: number | null) => Math.round(Math.max(0, Math.min(1, n ?? 0)) * 255);
  return `rgb(${v(c[0])}, ${v(c[1])}, ${v(c[2])})`;
}

function applyHighlights(
  divs: HTMLElement[],
  strs: string[],
  matches: TextMatch[],
  current: number | null,
  markClass: string,
  currentClass: string,
): HTMLElement | null {
  const perItem = new Map<number, { from: number; to: number; match: number }[]>();
  matches.forEach((m, match) => {
    for (let item = m.startItem; item <= m.endItem; item++) {
      const from = item === m.startItem ? m.startOffset : 0;
      const to = item === m.endItem ? m.endOffset : (strs[item]?.length ?? 0);
      if (to <= from) continue;
      const list = perItem.get(item) ?? [];
      list.push({ from, to, match });
      perItem.set(item, list);
    }
  });
  let target: HTMLElement | null = null;
  divs.forEach((div, i) => {
    const segs = perItem.get(i);
    if (!segs) {
      if (div.dataset.hl === "1") {
        div.textContent = strs[i] ?? "";
        delete div.dataset.hl;
      }
      return;
    }
    const text = strs[i] ?? "";
    div.replaceChildren();
    let pos = 0;
    for (const seg of segs) {
      if (seg.from > pos) div.append(document.createTextNode(text.slice(pos, seg.from)));
      const mark = document.createElement("span");
      mark.className = seg.match === current ? `${markClass} ${currentClass}` : markClass;
      mark.textContent = text.slice(seg.from, seg.to);
      if (seg.match === current && !target) target = mark;
      div.append(mark);
      pos = seg.to;
    }
    if (pos < text.length) div.append(document.createTextNode(text.slice(pos)));
    div.dataset.hl = "1";
  });
  return target;
}

function PageViewImpl({
  pdf,
  pageNumber,
  geometry,
  tool,
  strokeColor,
  pending,
  matches,
  currentMatch,
  onDraft,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<TextLayer | null>(null);
  const [layerVersion, setLayerVersion] = useState(0);
  const [drag, setDrag] = useState<{ start: [number, number]; points: [number, number][] } | null>(
    null,
  );
  const { width, height } = viewportSize(geometry);
  const { rotation, scale } = geometry;

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel(): void } | null = null;
    let textLayer: TextLayer | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale, rotation });
      const canvas = canvasRef.current;
      const container = textRef.current;
      if (!canvas || !container) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const task = page.render({
        canvas,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      });
      renderTask = task;
      await task.promise;
      if (cancelled) return;
      container.replaceChildren();
      textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport,
      });
      layerRef.current = textLayer;
      await textLayer.render();
      if (!cancelled) setLayerVersion((v) => v + 1);
    })().catch((e: unknown) => {
      if (!(e instanceof RenderingCancelledException)) console.error(e);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      if (layerRef.current === textLayer) layerRef.current = null;
    };
  }, [pdf, pageNumber, scale, rotation]);

  // Surlignage des résultats de recherche dans la couche texte
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || layerVersion === 0) return;
    const target = applyHighlights(
      layer.textDivs,
      layer.textContentItemsStr,
      matches,
      currentMatch,
      styles.mark!,
      styles.markCurrent!,
    );
    target?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [matches, currentMatch, layerVersion]);

  const drawing = tool === "note" || tool === "freeText" || tool === "ink";

  function local(e: PointerEvent<SVGSVGElement>): [number, number] {
    const box = e.currentTarget.getBoundingClientRect();
    return [e.clientX - box.left, e.clientY - box.top];
  }

  function onDown(e: PointerEvent<SVGSVGElement>) {
    if (!drawing || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = local(e);
    setDrag({ start: p, points: [p] });
  }

  function onMove(e: PointerEvent<SVGSVGElement>) {
    if (!drag) return;
    const p = local(e);
    setDrag(tool === "ink" ? { ...drag, points: [...drag.points, p] } : { ...drag, points: [p] });
  }

  function onUp(e: PointerEvent<SVGSVGElement>) {
    if (!drag) return;
    const end = local(e);
    const { start } = drag;
    setDrag(null);
    if (tool === "note") {
      onDraft(pageNumber, { kind: "note", point: end });
    } else if (tool === "freeText") {
      const small = Math.abs(end[0] - start[0]) < 5 && Math.abs(end[1] - start[1]) < 5;
      const rect: ViewRect = small
        ? {
            left: start[0],
            top: start[1],
            right: start[0] + 160 * scale,
            bottom: start[1] + 40 * scale,
          }
        : {
            left: Math.min(start[0], end[0]),
            top: Math.min(start[1], end[1]),
            right: Math.max(start[0], end[0]),
            bottom: Math.max(start[1], end[1]),
          };
      onDraft(pageNumber, { kind: "freeText", rect });
    } else if (tool === "ink" && drag.points.length > 1) {
      onDraft(pageNumber, { kind: "ink", points: [...drag.points, end] });
    }
  }

  const style = {
    width,
    height,
    "--scale-factor": scale,
    "--total-scale-factor": scale,
    "--user-unit": 1,
  } as CSSProperties;

  return (
    <div className={styles.page} style={style} data-page={pageNumber}>
      <canvas ref={canvasRef} className={styles.canvas} />
      <div ref={textRef} className="textLayer" />
      <svg
        className={styles.overlay}
        width={width}
        height={height}
        data-active={drawing}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => setDrag(null)}
      >
        {pending.map((a, i) => (
          <PendingShape key={i} a={a} geometry={geometry} />
        ))}
        {drag && tool === "ink" && (
          <polyline
            points={drag.points.map((p) => p.join(",")).join(" ")}
            fill="none"
            stroke={strokeColor}
            strokeWidth={2 * scale}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {drag && tool === "freeText" && drag.points[0] && (
          <rect
            x={Math.min(drag.start[0], drag.points[0][0])}
            y={Math.min(drag.start[1], drag.points[0][1])}
            width={Math.abs(drag.points[0][0] - drag.start[0])}
            height={Math.abs(drag.points[0][1] - drag.start[1])}
            fill="none"
            stroke={strokeColor}
            strokeDasharray="4 3"
          />
        )}
      </svg>
    </div>
  );
}

function PendingShape({ a, geometry }: { a: PdfAnnotation; geometry: PageGeometry }) {
  const color = rgb(a.color);
  const conv = (x: number | null, y: number | null) => toViewport(geometry, x ?? 0, y ?? 0);
  if (a.kind === "highlight" && a.quads) {
    const q = a.quads;
    const polys: string[] = [];
    for (let i = 0; i + 7 < q.length; i += 8) {
      // Ordre PDF HG, HD, BG, BD -> contour HG, HD, BD, BG
      const pts = [0, 2, 6, 4].map((k) => conv(q[i + k] ?? 0, q[i + k + 1] ?? 0).join(","));
      polys.push(pts.join(" "));
    }
    return (
      <g fill={color} fillOpacity={0.4} style={{ mixBlendMode: "multiply" }}>
        {polys.map((p, i) => (
          <polygon key={i} points={p} />
        ))}
      </g>
    );
  }
  if (a.kind === "ink" && a.inkList) {
    return (
      <g fill="none" stroke={color} strokeWidth={2 * geometry.scale} strokeLinecap="round">
        {a.inkList.map((stroke, i) => {
          const pts: string[] = [];
          for (let k = 0; k + 1 < stroke.length; k += 2)
            pts.push(conv(stroke[k]!, stroke[k + 1]!).join(","));
          return <polyline key={i} points={pts.join(" ")} strokeLinejoin="round" />;
        })}
      </g>
    );
  }
  const [x1, y1, x2, y2] = a.rect;
  const [ax, ay] = conv(x1, y1);
  const [bx, by] = conv(x2, y2);
  const x = Math.min(ax, bx);
  const y = Math.min(ay, by);
  const w = Math.abs(bx - ax);
  const h = Math.abs(by - ay);
  if (a.kind === "note") {
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} fill={color} stroke="#000" strokeWidth={0.5} rx={2}>
          <title>{a.contents ?? ""}</title>
        </rect>
      </g>
    );
  }
  const lines = (a.contents ?? "").split("\n");
  const fs = FREE_TEXT_FONT * geometry.scale;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill="none" stroke={color} strokeDasharray="3 2" />
      <text x={x + 2} y={y + fs} fontSize={fs} fill={color}>
        {lines.map((l, i) => (
          <tspan key={i} x={x + 2} dy={i === 0 ? 0 : fs * 1.2}>
            {l}
          </tspan>
        ))}
      </text>
    </g>
  );
}

export const PageView = memo(PageViewImpl);
