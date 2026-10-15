import { describe, expect, it } from "vitest";
import { boundsOf, hitTest, translate } from "./annotations";
import type { Annotation } from "./annotations";

const rect: Annotation = {
  id: 1,
  kind: "rect",
  x1: 10,
  y1: 10,
  x2: 50,
  y2: 40,
  color: "#f00",
  width: 2,
};
const text: Annotation = {
  id: 2,
  kind: "text",
  x: 100,
  y: 100,
  text: "abc",
  color: "#000",
  size: 10,
  font: "sans-serif",
};
const pen: Annotation = {
  id: 3,
  kind: "pen",
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ],
  color: "#000",
  width: 2,
};

describe("annotations", () => {
  it("sélectionne sur le contour d'un rectangle, pas à l'intérieur", () => {
    expect(hitTest([rect], { x: 30, y: 10 }, 3)?.id).toBe(1);
    expect(hitTest([rect], { x: 30, y: 25 }, 3)).toBeNull();
  });
  it("sélectionne le texte dans sa boîte et la plus haute annotation", () => {
    expect(hitTest([rect, text], { x: 105, y: 105 }, 2)?.id).toBe(2);
    expect(hitTest([text, { ...pen, id: 9 }], { x: 5, y: 1 }, 2)?.id).toBe(9);
  });
  it("déplace chaque type d'annotation", () => {
    expect(translate(rect, 5, -5)).toMatchObject({ x1: 15, y1: 5, x2: 55, y2: 35 });
    expect(translate(text, 1, 2)).toMatchObject({ x: 101, y: 102 });
    expect(translate(pen, 3, 3)).toMatchObject({
      points: [
        { x: 3, y: 3 },
        { x: 13, y: 3 },
      ],
    });
  });
  it("calcule la boîte englobante", () => {
    expect(boundsOf(rect)).toEqual({ x: 9, y: 9, w: 42, h: 32 });
  });
});
