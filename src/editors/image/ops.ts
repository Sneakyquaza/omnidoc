import type { Annotation } from "./annotations";
import { rotatedSize } from "./geometry";
import type { Rect, Size } from "./geometry";

export interface AdjustParams {
  /** -100..100 */
  brightness: number;
  /** -100..100 */
  contrast: number;
  /** -100..100 */
  saturation: number;
  grayscale: boolean;
}

export const NEUTRAL_ADJUST: AdjustParams = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  grayscale: false,
};

export type Op =
  | { type: "rotate"; turns: 1 | 2 | 3 }
  | { type: "flip"; axis: "h" | "v" }
  | { type: "crop"; rect: Rect }
  | { type: "resize"; width: number; height: number }
  | { type: "adjust"; params: AdjustParams }
  /** Instantané de la couche d'annotations (remplace le précédent). */
  | { type: "annotations"; items: Annotation[] };

/** Pile d'opérations non destructive, avec curseur d'annulation. Immuable. */
export interface OpStack {
  ops: Op[];
  /** Nombre d'opérations appliquées (`ops.slice(0, cursor)`). */
  cursor: number;
  /** Curseur au moment de la dernière sauvegarde (-1 : plus atteignable). */
  saved: number;
}

export function createStack(): OpStack {
  return { ops: [], cursor: 0, saved: 0 };
}

export function pushOp(s: OpStack, op: Op): OpStack {
  const ops = [...s.ops.slice(0, s.cursor), op];
  return { ops, cursor: ops.length, saved: s.saved > s.cursor ? -1 : s.saved };
}

export const canUndo = (s: OpStack): boolean => s.cursor > 0;
export const canRedo = (s: OpStack): boolean => s.cursor < s.ops.length;

export function undo(s: OpStack): OpStack {
  return canUndo(s) ? { ...s, cursor: s.cursor - 1 } : s;
}

export function redo(s: OpStack): OpStack {
  return canRedo(s) ? { ...s, cursor: s.cursor + 1 } : s;
}

/** Saute à un état de l'historique (0 = image d'origine). */
export function jumpTo(s: OpStack, cursor: number): OpStack {
  return { ...s, cursor: Math.max(0, Math.min(s.ops.length, cursor)) };
}

export const activeOps = (s: OpStack): Op[] => s.ops.slice(0, s.cursor);

export const markSaved = (s: OpStack): OpStack => ({ ...s, saved: s.cursor });

export const isDirty = (s: OpStack): boolean => s.cursor !== s.saved;

/** Dernier instantané d'annotations de la liste (couche « vivante »), sinon vide. */
export function liveAnnotations(ops: Op[]): Annotation[] {
  let last: Annotation[] = [];
  for (const op of ops) {
    if (op.type === "annotations") last = op.items;
    else last = [];
  }
  return last;
}

/** Dimensions de sortie après application des opérations. */
export function outputSize(ops: Op[], width: number, height: number): Size {
  let size: Size = { w: width, h: height };
  for (const op of ops) {
    if (op.type === "rotate") size = rotatedSize(size.w, size.h, op.turns);
    else if (op.type === "crop") size = { w: op.rect.w, h: op.rect.h };
    else if (op.type === "resize") size = { w: op.width, h: op.height };
  }
  return size;
}

export function isNeutral(p: AdjustParams): boolean {
  return p.brightness === 0 && p.contrast === 0 && p.saturation === 0 && !p.grayscale;
}

/** Applique luminosité / contraste / saturation / niveaux de gris (RGBA, en place). */
export function applyAdjust(data: Uint8ClampedArray, p: AdjustParams): void {
  const b = 1 + p.brightness / 100;
  const c = 1 + p.contrast / 100;
  const s = p.grayscale ? 0 : 1 + p.saturation / 100;
  for (let i = 0; i < data.length; i += 4) {
    let r = (data[i] ?? 0) * b;
    let g = (data[i + 1] ?? 0) * b;
    let bl = (data[i + 2] ?? 0) * b;
    r = (r - 128) * c + 128;
    g = (g - 128) * c + 128;
    bl = (bl - 128) * c + 128;
    const gray = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    data[i] = gray + (r - gray) * s;
    data[i + 1] = gray + (g - gray) * s;
    data[i + 2] = gray + (bl - gray) * s;
  }
}

export function opLabelKey(op: Op): string {
  switch (op.type) {
    case "rotate":
      return `history.rotate${op.turns * 90}`;
    case "flip":
      return op.axis === "h" ? "history.flipH" : "history.flipV";
    default:
      return `history.${op.type}`;
  }
}
