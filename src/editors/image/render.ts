import { drawAnnotation } from "./annotations";
import type { Annotation } from "./annotations";
import { applyAdjust, isNeutral } from "./ops";
import type { Op } from "./ops";

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function context(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas 2d indisponible");
  return ctx;
}

function copyOf(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  context(c).drawImage(src, 0, 0);
  return c;
}

/** Copie de `src` avec les annotations dessinées dessus. */
export function flatten(src: HTMLCanvasElement, layer: Annotation[]): HTMLCanvasElement {
  const c = copyOf(src);
  const ctx = context(c);
  for (const a of layer) drawAnnotation(ctx, a);
  return c;
}

function applyPixelOp(src: HTMLCanvasElement, op: Exclude<Op, { type: "annotations" }>) {
  switch (op.type) {
    case "rotate": {
      const swap = op.turns % 2 === 1;
      const c = makeCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
      const ctx = context(c);
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate((op.turns * Math.PI) / 2);
      ctx.drawImage(src, -src.width / 2, -src.height / 2);
      return c;
    }
    case "flip": {
      const c = makeCanvas(src.width, src.height);
      const ctx = context(c);
      if (op.axis === "h") ctx.transform(-1, 0, 0, 1, src.width, 0);
      else ctx.transform(1, 0, 0, -1, 0, src.height);
      ctx.drawImage(src, 0, 0);
      return c;
    }
    case "crop": {
      const c = makeCanvas(op.rect.w, op.rect.h);
      context(c).drawImage(
        src,
        op.rect.x,
        op.rect.y,
        op.rect.w,
        op.rect.h,
        0,
        0,
        c.width,
        c.height,
      );
      return c;
    }
    case "resize": {
      const c = makeCanvas(op.width, op.height);
      const ctx = context(c);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, 0, 0, c.width, c.height);
      return c;
    }
    case "adjust": {
      const c = copyOf(src);
      if (isNeutral(op.params)) return c;
      const ctx = context(c);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      applyAdjust(img.data, op.params);
      ctx.putImageData(img, 0, 0);
      return c;
    }
  }
}

/** Applique les opérations sur `source` (jamais modifiée). `live` = annotations non aplaties. */
export function renderOps(
  source: HTMLCanvasElement,
  ops: Op[],
): { canvas: HTMLCanvasElement; live: Annotation[] } {
  let cur = source;
  let layer: Annotation[] = [];
  for (const op of ops) {
    if (op.type === "annotations") {
      layer = op.items;
      continue;
    }
    if (layer.length > 0) {
      cur = flatten(cur, layer);
      layer = [];
    }
    cur = applyPixelOp(cur, op);
  }
  return { canvas: cur, live: layer };
}

/** Sépare les opérations en partie « pixels » (mise en cache) et couche d'annotations finale. */
export function splitOps(ops: Op[]): { head: Op[]; tail: Op[] } {
  let i = ops.length;
  while (i > 0 && ops[i - 1]?.type === "annotations") i--;
  return { head: ops.slice(0, i), tail: ops.slice(i) };
}

export function canvasToPngBase64(c: HTMLCanvasElement): string {
  const uri = c.toDataURL("image/png");
  return uri.slice(uri.indexOf(",") + 1);
}

const opIds = new WeakMap<Op, number>();
let nextOpId = 1;

/** Clé d'identité d'une liste d'opérations (pour la mise en cache du rendu). */
export function opsKey(ops: Op[]): string {
  return ops
    .map((op) => {
      let id = opIds.get(op);
      if (id === undefined) {
        id = nextOpId++;
        opIds.set(op, id);
      }
      return id;
    })
    .join(",");
}
