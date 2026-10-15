import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { boundsOf, drawAnnotation, hitTest, newAnnotationId, translate } from "./annotations";
import type { Annotation, ShapeKind, TextAnnotation, TextMeasure } from "./annotations";
import {
  HANDLES,
  PIXELATED_ZOOM,
  handlePosition,
  imageToScreen,
  moveRect,
  pointInRect,
  rectFromDrag,
  resizeRect,
  screenToImage,
  zoomAt,
} from "./geometry";
import type { Handle, Point, Rect, Size, View } from "./geometry";
import type { Tool, ToolOptions } from "./tools";
import styles from "./Viewport.module.css";

interface ViewportProps {
  canvas: HTMLCanvasElement;
  /** Annotations de la couche vivante. */
  annotations: Annotation[];
  onAnnotationsChange(items: Annotation[]): void;
  tool: Tool;
  options: ToolOptions;
  readOnly: boolean;
  selectedId: number | null;
  onSelect(id: number | null): void;
  view: View | null;
  onViewChange(view: View): void;
  onSize(size: Size): void;
  crop: Rect | null;
  onCropChange(rect: Rect | null): void;
  ratio: number | null;
  onApplyCrop(): void;
  onCursor(p: Point | null): void;
  /** Filtre CSS d'aperçu (ajustements en cours). */
  filter?: string;
}

type Drag =
  | { mode: "pan"; sx: number; sy: number; view: View }
  | { mode: "move"; id: number; start: Point }
  | { mode: "shape"; start: Point; kind: ShapeKind; id: number }
  | { mode: "pen"; id: number }
  | { mode: "cropNew"; start: Point }
  | { mode: "cropResize"; handle: Handle }
  | { mode: "cropMove"; last: Point };

const HANDLE_RADIUS = 9;
const HIT_TOLERANCE_PX = 6;

let measureCtx: CanvasRenderingContext2D | null = null;
const measureText: TextMeasure = (a) => {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return a.text.length * a.size * 0.6;
  measureCtx.font = `${a.size}px ${a.font}`;
  return Math.max(0, ...a.text.split("\n").map((l) => measureCtx!.measureText(l).width));
};

export function Viewport(props: ViewportProps) {
  const { t } = useTranslation("image");
  const {
    canvas,
    annotations,
    onAnnotationsChange,
    tool,
    options,
    readOnly,
    selectedId,
    onSelect,
    view,
    onViewChange,
    onSize,
    crop,
    onCropChange,
    ratio,
    onApplyCrop,
    onCursor,
    filter,
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [moving, setMoving] = useState<{ id: number; dx: number; dy: number } | null>(null);
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);

  const bounds: Size = { w: canvas.width, h: canvas.height };

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const s = { w: el.clientWidth, h: el.clientHeight };
      setSize(s);
      onSize(s);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onSize]);

  // Molette : zoom centré sur le curseur (écouteur natif non passif pour bloquer le défilement)
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !view) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      onViewChange(
        zoomAt(view, Math.exp(-e.deltaY * 0.0015), { x: e.clientX - r.left, y: e.clientY - r.top }),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [view, onViewChange]);

  // Rendu
  useEffect(() => {
    const cv = displayRef.current;
    if (!cv || !view || size.w === 0 || size.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const accent = getComputedStyle(cv).getPropertyValue("--color-accent").trim() || "#2563eb";
    const { zoom, panX, panY } = view;
    const iw = canvas.width;
    const ih = canvas.height;

    // Image sur damier
    ctx.save();
    ctx.beginPath();
    ctx.rect(panX, panY, iw * zoom, ih * zoom);
    ctx.clip();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(panX, panY, iw * zoom, ih * zoom);
    ctx.fillStyle = "#d4d4d8";
    const cell = 10;
    const x0 = Math.max(panX, 0);
    const y0 = Math.max(panY, 0);
    const x1 = Math.min(panX + iw * zoom, size.w);
    const y1 = Math.min(panY + ih * zoom, size.h);
    for (let y = Math.floor((y0 - panY) / cell); panY + y * cell < y1; y++) {
      for (let x = Math.floor((x0 - panX) / cell); panX + x * cell < x1; x++) {
        if ((x + y) % 2 !== 0) ctx.fillRect(panX + x * cell, panY + y * cell, cell, cell);
      }
    }
    ctx.imageSmoothingEnabled = zoom < PIXELATED_ZOOM;
    ctx.drawImage(canvas, panX, panY, iw * zoom, ih * zoom);
    ctx.restore();

    // Annotations (coordonnées image)
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);
    ctx.beginPath();
    ctx.rect(0, 0, iw, ih);
    ctx.clip();
    const shown = annotations.map((a) =>
      moving && a.id === moving.id ? translate(a, moving.dx, moving.dy) : a,
    );
    if (draft) shown.push(draft);
    for (const a of shown) drawAnnotation(ctx, a);
    ctx.restore();

    const selected = shown.find((a) => a.id === selectedId);
    if (selected && tool === "select") {
      const b = boundsOf(selected, measureText);
      const tl = imageToScreen({ x: b.x, y: b.y }, view);
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(tl.x - 2, tl.y - 2, b.w * zoom + 4, b.h * zoom + 4);
      ctx.restore();
    }

    // Recadrage : voile + cadre + poignées
    if (tool === "crop" && crop) {
      const tl = imageToScreen({ x: crop.x, y: crop.y }, view);
      const cw = crop.w * zoom;
      const ch = crop.h * zoom;
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
      ctx.beginPath();
      ctx.rect(panX, panY, iw * zoom, ih * zoom);
      ctx.rect(tl.x, tl.y, cw, ch);
      ctx.fill("evenodd");
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(tl.x, tl.y, cw, ch);
      ctx.fillStyle = "#ffffff";
      for (const h of HANDLES) {
        const p = imageToScreen(handlePosition(crop, h), view);
        ctx.beginPath();
        ctx.rect(p.x - 4, p.y - 4, 8, 8);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [canvas, annotations, draft, moving, view, size, crop, tool, selectedId]);

  function screenPoint(e: { clientX: number; clientY: number }): Point {
    const r = rootRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function commitText(td: { x: number; y: number; value: string }) {
    setTextDraft(null);
    const value = td.value.trim();
    if (!value) return;
    const a: TextAnnotation = {
      id: newAnnotationId(),
      kind: "text",
      x: td.x,
      y: td.y,
      text: value,
      color: options.color,
      size: options.fontSize,
      font: options.font,
    };
    onAnnotationsChange([...annotations, a]);
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    rootRef.current?.focus();
    if (!view) return;
    const sp = screenPoint(e);
    const p = screenToImage(sp, view);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.button === 1 || space) {
      e.preventDefault();
      dragRef.current = { mode: "pan", sx: sp.x, sy: sp.y, view };
      setPanning(true);
      return;
    }
    if (e.button !== 0) return;
    if (tool === "select") {
      const hit = hitTest(annotations, p, HIT_TOLERANCE_PX / view.zoom, measureText);
      onSelect(hit ? hit.id : null);
      if (hit && !readOnly) dragRef.current = { mode: "move", id: hit.id, start: p };
      return;
    }
    if (readOnly) return;
    if (tool === "crop") {
      if (crop) {
        for (const h of HANDLES) {
          const hp = imageToScreen(handlePosition(crop, h), view);
          if (Math.hypot(hp.x - sp.x, hp.y - sp.y) <= HANDLE_RADIUS) {
            dragRef.current = { mode: "cropResize", handle: h };
            return;
          }
        }
        if (pointInRect(p, crop)) {
          dragRef.current = { mode: "cropMove", last: p };
          return;
        }
      }
      dragRef.current = { mode: "cropNew", start: p };
      onCropChange(null);
      return;
    }
    if (tool === "text") {
      setTextDraft({ x: p.x, y: p.y, value: "" });
      return;
    }
    const id = newAnnotationId();
    if (tool === "pen") {
      dragRef.current = { mode: "pen", id };
      setDraft({ id, kind: "pen", points: [p], color: options.color, width: options.width });
    } else {
      dragRef.current = { mode: "shape", start: p, kind: tool, id };
      setDraft({
        id,
        kind: tool,
        x1: p.x,
        y1: p.y,
        x2: p.x,
        y2: p.y,
        color: options.color,
        width: options.width,
      });
    }
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!view) return;
    const sp = screenPoint(e);
    const p = screenToImage(sp, view);
    onCursor(p);
    const drag = dragRef.current;
    if (!drag) return;
    switch (drag.mode) {
      case "pan":
        onViewChange({
          zoom: drag.view.zoom,
          panX: drag.view.panX + sp.x - drag.sx,
          panY: drag.view.panY + sp.y - drag.sy,
        });
        break;
      case "move":
        setMoving({ id: drag.id, dx: p.x - drag.start.x, dy: p.y - drag.start.y });
        break;
      case "shape":
        setDraft((d) => {
          if (!d || d.kind === "pen" || d.kind === "text") return d;
          let { x, y } = p;
          if (e.shiftKey && drag.kind !== "arrow" && drag.kind !== "highlight") {
            const m = Math.max(Math.abs(x - d.x1), Math.abs(y - d.y1));
            x = d.x1 + Math.sign(x - d.x1 || 1) * m;
            y = d.y1 + Math.sign(y - d.y1 || 1) * m;
          }
          return { ...d, x2: x, y2: y };
        });
        break;
      case "pen":
        setDraft((d) => (d && d.kind === "pen" ? { ...d, points: [...d.points, p] } : d));
        break;
      case "cropNew":
        onCropChange(rectFromDrag(drag.start, p, ratio, bounds));
        break;
      case "cropResize":
        if (crop) onCropChange(resizeRect(crop, drag.handle, p, ratio, bounds));
        break;
      case "cropMove":
        if (crop) onCropChange(moveRect(crop, p.x - drag.last.x, p.y - drag.last.y, bounds));
        dragRef.current = { mode: "cropMove", last: p };
        break;
    }
  }

  function onPointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    if (!drag) return;
    if (drag.mode === "move") {
      const m = moving;
      setMoving(null);
      if (m && (m.dx !== 0 || m.dy !== 0)) {
        onAnnotationsChange(annotations.map((a) => (a.id === m.id ? translate(a, m.dx, m.dy) : a)));
      }
    } else if (drag.mode === "shape" || drag.mode === "pen") {
      const d = draft;
      setDraft(null);
      if (!d) return;
      const tiny =
        d.kind !== "pen" &&
        d.kind !== "text" &&
        Math.hypot(d.x2 - d.x1, d.y2 - d.y1) * (view?.zoom ?? 1) < 3;
      if (!tiny) onAnnotationsChange([...annotations, d]);
    } else if (drag.mode === "cropNew" && crop && (crop.w < 2 || crop.h < 2)) {
      onCropChange(null);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === " ") {
      e.preventDefault();
      setSpace(true);
    } else if (e.key === "Enter" && tool === "crop" && crop) {
      e.preventDefault();
      onApplyCrop();
    } else if (e.key === "Escape") {
      setTextDraft(null);
      if (tool === "crop") onCropChange(null);
      else onSelect(null);
    } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId !== null && !readOnly) {
      e.preventDefault();
      onAnnotationsChange(annotations.filter((a) => a.id !== selectedId));
      onSelect(null);
    } else if (e.key.startsWith("Arrow") && selectedId !== null && !readOnly && tool === "select") {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      onAnnotationsChange(annotations.map((a) => (a.id === selectedId ? translate(a, dx, dy) : a)));
    }
  }

  const cursor = panning
    ? "grabbing"
    : space
      ? "grab"
      : tool === "select"
        ? "default"
        : "crosshair";
  const textScreen = textDraft && view ? imageToScreen(textDraft, view) : null;

  return (
    <div
      ref={rootRef}
      className={styles.root}
      style={{ cursor }}
      tabIndex={0}
      role="application"
      aria-label={t("viewport.label")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => onCursor(null)}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => {
        if (e.key === " ") setSpace(false);
      }}
      onBlur={() => setSpace(false)}
    >
      <canvas ref={displayRef} className={styles.canvas} style={{ filter }} />
      {textDraft && textScreen && view && (
        <input
          className={styles.textInput}
          style={{
            left: textScreen.x,
            top: textScreen.y,
            fontSize: Math.max(10, options.fontSize * view.zoom),
            fontFamily: options.font,
            color: options.color,
          }}
          autoFocus
          aria-label={t("viewport.textInput")}
          value={textDraft.value}
          onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitText(textDraft);
            else if (e.key === "Escape") setTextDraft(null);
          }}
          onBlur={() => textDraft && commitText(textDraft)}
        />
      )}
    </div>
  );
}
