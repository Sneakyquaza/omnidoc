import type { Point, Rect } from "./geometry";

export type ShapeKind = "arrow" | "rect" | "ellipse" | "highlight";

export interface ShapeAnnotation {
  id: number;
  kind: ShapeKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
}

export interface PenAnnotation {
  id: number;
  kind: "pen";
  points: Point[];
  color: string;
  width: number;
}

export interface TextAnnotation {
  id: number;
  kind: "text";
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  font: string;
}

export type Annotation = ShapeAnnotation | PenAnnotation | TextAnnotation;

export const HIGHLIGHT_ALPHA = 0.35;
/** Le surligneur est plus épais que le trait de base. */
export const HIGHLIGHT_FACTOR = 4;

let nextId = 1;
export function newAnnotationId(): number {
  return nextId++;
}

/** Mesure de largeur d'un texte ; par défaut une estimation grossière. */
export type TextMeasure = (a: TextAnnotation) => number;

export function estimateTextWidth(a: TextAnnotation): number {
  const longest = Math.max(0, ...a.text.split("\n").map((l) => l.length));
  return longest * a.size * 0.6;
}

export function textBounds(a: TextAnnotation, measure: TextMeasure = estimateTextWidth): Rect {
  const lines = a.text.split("\n").length;
  return { x: a.x, y: a.y, w: measure(a), h: lines * a.size * 1.25 };
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance (px image) du point à l'annotation ; 0 si dessus. */
export function distanceTo(a: Annotation, p: Point, measure?: TextMeasure): number {
  switch (a.kind) {
    case "text": {
      const b = textBounds(a, measure);
      const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
      const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
      return Math.hypot(dx, dy);
    }
    case "pen": {
      let best = Infinity;
      a.points.forEach((q, i) => {
        const prev = i === 0 ? q : (a.points[i - 1] ?? q);
        best = Math.min(best, distToSegment(p, prev, q));
      });
      return best;
    }
    case "arrow":
    case "highlight":
      return distToSegment(p, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 });
    case "rect": {
      const x1 = Math.min(a.x1, a.x2);
      const x2 = Math.max(a.x1, a.x2);
      const y1 = Math.min(a.y1, a.y2);
      const y2 = Math.max(a.y1, a.y2);
      const corners = [
        { x: x1, y: y1 },
        { x: x2, y: y1 },
        { x: x2, y: y2 },
        { x: x1, y: y2 },
      ];
      return Math.min(...corners.map((c, i) => distToSegment(p, c, corners[(i + 1) % 4] ?? c)));
    }
    case "ellipse": {
      const cx = (a.x1 + a.x2) / 2;
      const cy = (a.y1 + a.y2) / 2;
      const rx = Math.abs(a.x2 - a.x1) / 2;
      const ry = Math.abs(a.y2 - a.y1) / 2;
      if (rx === 0 || ry === 0) return distToSegment(p, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 });
      // Approximation : écart radial normalisé, ramené à une distance moyenne.
      const k = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
      return Math.abs(k - 1) * Math.min(rx, ry);
    }
  }
}

/** Annotation la plus haute (dernière) sous le point, avec une tolérance en px image. */
export function hitTest(
  list: Annotation[],
  p: Point,
  tolerance: number,
  measure?: TextMeasure,
): Annotation | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (!a) continue;
    const slack =
      a.kind === "text" ? 0 : (a.kind === "highlight" ? a.width * HIGHLIGHT_FACTOR : a.width) / 2;
    if (distanceTo(a, p, measure) <= tolerance + slack) return a;
  }
  return null;
}

export function translate(a: Annotation, dx: number, dy: number): Annotation {
  switch (a.kind) {
    case "text":
      return { ...a, x: a.x + dx, y: a.y + dy };
    case "pen":
      return { ...a, points: a.points.map((q) => ({ x: q.x + dx, y: q.y + dy })) };
    default:
      return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
  }
}

/** Dessine l'annotation (coordonnées image ; le contexte porte la transformation de vue). */
export function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation): void {
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  switch (a.kind) {
    case "text": {
      ctx.font = `${a.size}px ${a.font}`;
      ctx.textBaseline = "top";
      a.text.split("\n").forEach((line, i) => ctx.fillText(line, a.x, a.y + i * a.size * 1.25));
      break;
    }
    case "pen": {
      ctx.lineWidth = a.width;
      ctx.beginPath();
      a.points.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
      if (a.points.length === 1) ctx.lineTo((a.points[0]?.x ?? 0) + 0.01, a.points[0]?.y ?? 0);
      ctx.stroke();
      break;
    }
    case "rect":
      ctx.lineWidth = a.width;
      ctx.strokeRect(
        Math.min(a.x1, a.x2),
        Math.min(a.y1, a.y2),
        Math.abs(a.x2 - a.x1),
        Math.abs(a.y2 - a.y1),
      );
      break;
    case "ellipse":
      ctx.lineWidth = a.width;
      ctx.beginPath();
      ctx.ellipse(
        (a.x1 + a.x2) / 2,
        (a.y1 + a.y2) / 2,
        Math.abs(a.x2 - a.x1) / 2,
        Math.abs(a.y2 - a.y1) / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    case "highlight":
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.lineCap = "butt";
      ctx.lineWidth = a.width * HIGHLIGHT_FACTOR;
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      ctx.lineTo(a.x2, a.y2);
      ctx.stroke();
      break;
    case "arrow": {
      ctx.lineWidth = a.width;
      const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
      const head = Math.max(10, a.width * 4);
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      ctx.lineTo(a.x2, a.y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(a.x2, a.y2);
      ctx.lineTo(
        a.x2 - head * Math.cos(angle - Math.PI / 6),
        a.y2 - head * Math.sin(angle - Math.PI / 6),
      );
      ctx.lineTo(
        a.x2 - head * Math.cos(angle + Math.PI / 6),
        a.y2 - head * Math.sin(angle + Math.PI / 6),
      );
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

/** Boîte englobante (pour le cadre de sélection). */
export function boundsOf(a: Annotation, measure?: TextMeasure): Rect {
  if (a.kind === "text") return textBounds(a, measure);
  const pad = a.kind === "highlight" ? (a.width * HIGHLIGHT_FACTOR) / 2 : a.width / 2;
  const pts: Point[] =
    a.kind === "pen"
      ? a.points
      : [
          { x: a.x1, y: a.y1 },
          { x: a.x2, y: a.y2 },
        ];
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}
