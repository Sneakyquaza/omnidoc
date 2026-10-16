/** Géométrie d'une page affichée : `view` = [x0, y0, x1, y1] (espace PDF), rotation totale, échelle. */
export interface PageGeometry {
  view: [number, number, number, number];
  rotation: number;
  scale: number;
}

/** Rectangle en pixels du viewport (origine en haut à gauche). */
export interface ViewRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type PdfRect = [number, number, number, number];

export function normRotation(r: number): number {
  return (((Math.round(r / 90) * 90) % 360) + 360) % 360;
}

/** Taille du viewport en pixels. */
export function viewportSize(g: PageGeometry): { width: number; height: number } {
  const w = (g.view[2] - g.view[0]) * g.scale;
  const h = (g.view[3] - g.view[1]) * g.scale;
  return normRotation(g.rotation) % 180 === 0 ? { width: w, height: h } : { width: h, height: w };
}

/** Espace utilisateur PDF → pixels du viewport (équivalent de `PageViewport.convertToViewportPoint`). */
export function toViewport(g: PageGeometry, x: number, y: number): [number, number] {
  const [x0, y0, x1, y1] = g.view;
  const s = g.scale;
  switch (normRotation(g.rotation)) {
    case 90:
      return [(y - y0) * s, (x - x0) * s];
    case 180:
      return [(x1 - x) * s, (y - y0) * s];
    case 270:
      return [(y1 - y) * s, (x1 - x) * s];
    default:
      return [(x - x0) * s, (y1 - y) * s];
  }
}

/** Pixels du viewport → espace utilisateur PDF (équivalent de `PageViewport.convertToPdfPoint`). */
export function toPdf(g: PageGeometry, vx: number, vy: number): [number, number] {
  const [x0, y0, x1, y1] = g.view;
  const s = g.scale;
  switch (normRotation(g.rotation)) {
    case 90:
      return [x0 + vy / s, y0 + vx / s];
    case 180:
      return [x1 - vx / s, y0 + vy / s];
    case 270:
      return [x1 - vy / s, y1 - vx / s];
    default:
      return [x0 + vx / s, y1 - vy / s];
  }
}

function bbox(points: [number, number][]): PdfRect {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Boîte englobante PDF d'un rectangle du viewport. */
export function viewRectToPdfRect(g: PageGeometry, r: ViewRect): PdfRect {
  return bbox([toPdf(g, r.left, r.top), toPdf(g, r.right, r.bottom)]);
}

/** Aplatit un tracé du viewport en x,y,x,y… PDF. */
export function strokeToPdf(g: PageGeometry, points: [number, number][]): number[] {
  return points.flatMap(([vx, vy]) => toPdf(g, vx, vy));
}

/** Boîte englobante d'un tracé x,y,x,y…, élargie de `pad`. */
export function strokeBounds(coords: number[], pad: number): PdfRect {
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < coords.length; i += 2) pts.push([coords[i]!, coords[i + 1]!]);
  const [a, b, c, d] = bbox(pts);
  return [a - pad, b - pad, c + pad, d + pad];
}

function contains(a: ViewRect, b: ViewRect, tol: number): boolean {
  return (
    a.left <= b.left + tol &&
    a.top <= b.top + tol &&
    a.right >= b.right - tol &&
    a.bottom >= b.bottom - tol
  );
}

/**
 * Rectangles de sélection (viewport) → quads de surlignage PDF + rectangle englobant.
 * Chaque quad suit l'ordre habituel : haut-gauche, haut-droite, bas-gauche, bas-droite (vus à l'écran).
 * Les rectangles dégénérés ou inclus dans un autre sont ignorés.
 */
export function rectsToQuads(
  g: PageGeometry,
  rects: ViewRect[],
): { quads: number[]; rect: PdfRect } | null {
  const tol = 0.5;
  const valid = rects.filter((r) => r.right - r.left >= 1 && r.bottom - r.top >= 1);
  const kept = valid.filter(
    (r, i) =>
      !valid.some((o, j) => j !== i && contains(o, r, tol) && (!contains(r, o, tol) || j < i)),
  );
  if (kept.length === 0) return null;
  const quads: number[] = [];
  const all: [number, number][] = [];
  for (const r of kept) {
    const corners: [number, number][] = [
      [r.left, r.top],
      [r.right, r.top],
      [r.left, r.bottom],
      [r.right, r.bottom],
    ];
    for (const [vx, vy] of corners) {
      const p = toPdf(g, vx, vy);
      quads.push(p[0], p[1]);
      all.push(p);
    }
  }
  return { quads, rect: bbox(all) };
}
