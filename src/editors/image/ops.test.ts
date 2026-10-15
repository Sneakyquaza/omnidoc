import { describe, expect, it } from "vitest";
import {
  activeOps,
  applyAdjust,
  canRedo,
  canUndo,
  createStack,
  isDirty,
  jumpTo,
  liveAnnotations,
  markSaved,
  outputSize,
  pushOp,
  redo,
  undo,
} from "./ops";
import type { Op } from "./ops";

const rot: Op = { type: "rotate", turns: 1 };
const flip: Op = { type: "flip", axis: "h" };
const crop: Op = { type: "crop", rect: { x: 0, y: 0, w: 10, h: 20 } };

describe("pile d'opérations", () => {
  it("empile, annule et rétablit", () => {
    let s = createStack();
    expect(canUndo(s)).toBe(false);
    s = pushOp(pushOp(s, rot), flip);
    expect(activeOps(s)).toEqual([rot, flip]);
    s = undo(s);
    expect(activeOps(s)).toEqual([rot]);
    expect(canRedo(s)).toBe(true);
    s = redo(s);
    expect(activeOps(s)).toEqual([rot, flip]);
    expect(canRedo(s)).toBe(false);
    expect(redo(s)).toBe(s);
  });
  it("une nouvelle opération vide la pile de rétablissement", () => {
    let s = pushOp(pushOp(createStack(), rot), flip);
    s = undo(undo(s));
    s = pushOp(s, crop);
    expect(s.ops).toEqual([crop]);
    expect(canRedo(s)).toBe(false);
  });
  it("undo sur pile vide ne change rien", () => {
    const s = createStack();
    expect(undo(s)).toBe(s);
  });
  it("suit l'état modifié par rapport à la sauvegarde", () => {
    let s = createStack();
    expect(isDirty(s)).toBe(false);
    s = pushOp(s, rot);
    expect(isDirty(s)).toBe(true);
    s = markSaved(s);
    expect(isDirty(s)).toBe(false);
    s = undo(s);
    expect(isDirty(s)).toBe(true);
    s = redo(s);
    expect(isDirty(s)).toBe(false);
    // sauvegarde ensuite perdue par une nouvelle branche
    s = pushOp(undo(s), flip);
    expect(isDirty(s)).toBe(true);
    expect(isDirty(undo(s))).toBe(true);
  });
  it("jumpTo borne le curseur", () => {
    const s = pushOp(pushOp(createStack(), rot), flip);
    expect(jumpTo(s, 0).cursor).toBe(0);
    expect(jumpTo(s, 99).cursor).toBe(2);
  });
});

describe("dimensions de sortie", () => {
  it("compose rotation, recadrage et redimensionnement", () => {
    expect(outputSize([], 100, 50)).toEqual({ w: 100, h: 50 });
    expect(outputSize([rot], 100, 50)).toEqual({ w: 50, h: 100 });
    expect(outputSize([rot, crop], 100, 50)).toEqual({ w: 10, h: 20 });
    expect(outputSize([crop, { type: "resize", width: 5, height: 7 }, flip], 100, 50)).toEqual({
      w: 5,
      h: 7,
    });
  });
});

describe("couche d'annotations", () => {
  const item = {
    id: 1,
    kind: "rect" as const,
    x1: 0,
    y1: 0,
    x2: 5,
    y2: 5,
    color: "#f00",
    width: 2,
  };
  it("est vivante jusqu'à la prochaine opération de pixels", () => {
    expect(liveAnnotations([{ type: "annotations", items: [item] }])).toEqual([item]);
    expect(liveAnnotations([{ type: "annotations", items: [item] }, rot])).toEqual([]);
    expect(
      liveAnnotations([
        { type: "annotations", items: [item] },
        { type: "annotations", items: [] },
      ]),
    ).toEqual([]);
  });
});

describe("ajustements", () => {
  const px = (r: number, g: number, b: number) => new Uint8ClampedArray([r, g, b, 255]);
  const neutral = { brightness: 0, contrast: 0, saturation: 0, grayscale: false };
  it("neutre = identité", () => {
    const d = px(10, 120, 250);
    applyAdjust(d, neutral);
    expect(Array.from(d)).toEqual([10, 120, 250, 255]);
  });
  it("luminosité et bornes", () => {
    const d = px(100, 200, 50);
    applyAdjust(d, { ...neutral, brightness: 100 });
    expect(Array.from(d)).toEqual([200, 255, 100, 255]);
  });
  it("niveaux de gris", () => {
    const d = px(255, 0, 0);
    applyAdjust(d, { ...neutral, grayscale: true });
    expect(d[0]).toBe(d[1]);
    expect(d[1]).toBe(d[2]);
  });
});
