export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** Vue : écran = image × zoom + pan (pan en pixels écran, depuis le coin du viewport). */
export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;
/** Au-delà de ce zoom, le rendu passe en pixels nets (sans lissage). */
export const PIXELATED_ZOOM = 4;
const MIN_SIZE = 1;

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function screenToImage(p: Point, view: View): Point {
  return { x: (p.x - view.panX) / view.zoom, y: (p.y - view.panY) / view.zoom };
}

export function imageToScreen(p: Point, view: View): Point {
  return { x: p.x * view.zoom + view.panX, y: p.y * view.zoom + view.panY };
}

/** Change le zoom en gardant fixe le point d'écran `anchor`. */
export function zoomAt(view: View, factor: number, anchor: Point): View {
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const real = zoom / view.zoom;
  return {
    zoom,
    panX: anchor.x - (anchor.x - view.panX) * real,
    panY: anchor.y - (anchor.y - view.panY) * real,
  };
}

export function centerView(vw: number, vh: number, iw: number, ih: number, zoom: number): View {
  return { zoom, panX: (vw - iw * zoom) / 2, panY: (vh - ih * zoom) / 2 };
}

/** Zoom qui fait tenir l'image dans le viewport (jamais agrandie au-delà de 100 %), centrée. */
export function fitView(vw: number, vh: number, iw: number, ih: number, margin = 16): View {
  const zoom =
    iw <= 0 || ih <= 0
      ? 1
      : clamp(Math.min((vw - 2 * margin) / iw, (vh - 2 * margin) / ih, 1), MIN_ZOOM, MAX_ZOOM);
  return centerView(vw, vh, iw, ih, zoom);
}

/** Rotation d'un point dans une image `w`×`h`, `turns` quarts de tour horaires. */
export function rotatePoint(p: Point, w: number, h: number, turns: number): Point {
  switch (((turns % 4) + 4) % 4) {
    case 1:
      return { x: h - p.y, y: p.x };
    case 2:
      return { x: w - p.x, y: h - p.y };
    case 3:
      return { x: p.y, y: w - p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** Rectangle d'une image `w`×`h` après rotation de `turns` quarts de tour horaires. */
export function rotateRect(r: Rect, w: number, h: number, turns: number): Rect {
  const a = rotatePoint({ x: r.x, y: r.y }, w, h, turns);
  const b = rotatePoint({ x: r.x + r.w, y: r.y + r.h }, w, h, turns);
  return normalizeRect(a, b);
}

export function flipRect(r: Rect, w: number, h: number, axis: "h" | "v"): Rect {
  return axis === "h" ? { ...r, x: w - r.x - r.w } : { ...r, y: h - r.y - r.h };
}

/** Dimensions après `turns` quarts de tour. */
export function rotatedSize(w: number, h: number, turns: number): Size {
  return turns % 2 === 0 ? { w, h } : { w: h, h: w };
}

/** Redimensionnement avec proportions conservées : calcule l'autre dimension (≥ 1). */
export function proportionalSize(
  from: "width" | "height",
  value: number,
  origW: number,
  origH: number,
): { width: number; height: number } {
  const v = Math.max(1, Math.round(value));
  return from === "width"
    ? { width: v, height: Math.max(1, Math.round((v * origH) / origW)) }
    : { width: Math.max(1, Math.round((v * origW) / origH)), height: v };
}

export function percentSize(
  percent: number,
  origW: number,
  origH: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round((origW * percent) / 100)),
    height: Math.max(1, Math.round((origH * percent) / 100)),
  };
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function handlePosition(r: Rect, handle: Handle): Point {
  const x = handle.includes("w") ? r.x : handle.includes("e") ? r.x + r.w : r.x + r.w / 2;
  const y = handle.includes("n") ? r.y : handle.includes("s") ? r.y + r.h : r.y + r.h / 2;
  return { x, y };
}

type Anchor = "start" | "end" | "center";

/** Réduit `r` pour tenir dans `bounds` en gardant le ratio ; le côté ancré ne bouge pas. */
function fitRatioRect(r: Rect, bounds: Size, ax: Anchor, ay: Anchor): Rect {
  const avail = (a: Anchor, start: number, size: number, max: number) =>
    a === "start"
      ? max - start
      : a === "end"
        ? start + size
        : 2 * Math.min(start + size / 2, max - start - size / 2);
  const scale = Math.min(
    1,
    avail(ax, r.x, r.w, bounds.w) / r.w,
    avail(ay, r.y, r.h, bounds.h) / r.h,
  );
  const w = r.w * scale;
  const h = r.h * scale;
  const place = (a: Anchor, start: number, size: number, newSize: number) =>
    a === "start" ? start : a === "end" ? start + size - newSize : start + size / 2 - newSize / 2;
  return { x: place(ax, r.x, r.w, w), y: place(ay, r.y, r.h, h), w, h };
}

/** Redimensionne `rect` en tirant la poignée `handle` jusqu'au point image `p` (ratio l/h optionnel). */
export function resizeRect(
  rect: Rect,
  handle: Handle,
  p: Point,
  ratio: number | null,
  bounds: Size,
): Rect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;
  if (handle.includes("w")) left = clamp(p.x, 0, right - MIN_SIZE);
  if (handle.includes("e")) right = clamp(p.x, left + MIN_SIZE, bounds.w);
  if (handle.includes("n")) top = clamp(p.y, 0, bottom - MIN_SIZE);
  if (handle.includes("s")) bottom = clamp(p.y, top + MIN_SIZE, bounds.h);
  const r: Rect = { x: left, y: top, w: right - left, h: bottom - top };
  if (ratio === null) return r;
  const hasH = handle.includes("w") || handle.includes("e");
  const hasV = handle.includes("n") || handle.includes("s");
  let w = r.w;
  let h = r.h;
  if (hasH && hasV) {
    if (w / h > ratio) h = w / ratio;
    else w = h * ratio;
  } else if (hasH) h = w / ratio;
  else w = h * ratio;
  // Le côté opposé à la poignée reste fixe.
  const ax: Anchor = handle.includes("w") ? "end" : handle.includes("e") ? "start" : "center";
  const ay: Anchor = handle.includes("n") ? "end" : handle.includes("s") ? "start" : "center";
  const x = ax === "end" ? right - w : ax === "start" ? left : r.x + r.w / 2 - w / 2;
  const y = ay === "end" ? bottom - h : ay === "start" ? top : r.y + r.h / 2 - h / 2;
  return fitRatioRect({ x, y, w, h }, bounds, ax, ay);
}

/** Rectangle tiré de `a` vers `p` (création), borné à l'image, ratio l/h optionnel. */
export function rectFromDrag(a: Point, p: Point, ratio: number | null, bounds: Size): Rect {
  const ca = { x: clamp(a.x, 0, bounds.w), y: clamp(a.y, 0, bounds.h) };
  const cp = { x: clamp(p.x, 0, bounds.w), y: clamp(p.y, 0, bounds.h) };
  const r = normalizeRect(ca, cp);
  if (ratio === null) return r;
  let w = r.w;
  let h = r.h;
  if (w / Math.max(h, 1e-9) > ratio) h = w / ratio;
  else w = h * ratio;
  const ax: Anchor = cp.x >= ca.x ? "start" : "end";
  const ay: Anchor = cp.y >= ca.y ? "start" : "end";
  const x = ax === "start" ? ca.x : ca.x - w;
  const y = ay === "start" ? ca.y : ca.y - h;
  return fitRatioRect(
    { x, y, w, h },
    bounds,
    ax === "start" ? "start" : "end",
    ay === "start" ? "start" : "end",
  );
}

/** Adapte un rectangle existant à un ratio (centré, borné). */
export function fitRectToRatio(r: Rect, ratio: number, bounds: Size): Rect {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  let w = r.w;
  let h = r.w / ratio;
  if (h > r.h) {
    h = r.h;
    w = h * ratio;
  }
  return fitRatioRect({ x: cx - w / 2, y: cy - h / 2, w, h }, bounds, "center", "center");
}

export function moveRect(r: Rect, dx: number, dy: number, bounds: Size): Rect {
  return {
    ...r,
    x: clamp(r.x + dx, 0, bounds.w - r.w),
    y: clamp(r.y + dy, 0, bounds.h - r.h),
  };
}

/** Rectangle en pixels entiers pour un recadrage effectif. */
export function roundRect(r: Rect, bounds: Size): Rect {
  const x = clamp(Math.round(r.x), 0, bounds.w - 1);
  const y = clamp(Math.round(r.y), 0, bounds.h - 1);
  const w = clamp(Math.round(r.x + r.w) - x, 1, bounds.w - x);
  const h = clamp(Math.round(r.y + r.h) - y, 1, bounds.h - y);
  return { x, y, w, h };
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export const RATIOS = { free: null, "1:1": 1, "4:3": 4 / 3, "16:9": 16 / 9 } as const;
export type RatioKey = keyof typeof RATIOS;
