import { describe, expect, it } from "vitest";
import {
  centerView,
  fitRectToRatio,
  fitView,
  flipRect,
  imageToScreen,
  moveRect,
  percentSize,
  proportionalSize,
  rectFromDrag,
  resizeRect,
  rotatePoint,
  rotateRect,
  roundRect,
  screenToImage,
  zoomAt,
} from "./geometry";

describe("conversion écran ↔ image", () => {
  const view = { zoom: 2, panX: 30, panY: -10 };
  it("est réversible", () => {
    const p = { x: 12.5, y: 7 };
    const back = screenToImage(imageToScreen(p, view), view);
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });
  it("applique zoom et pan", () => {
    expect(screenToImage({ x: 50, y: 10 }, view)).toEqual({ x: 10, y: 10 });
  });
  it("zoomAt garde le point d'ancrage fixe", () => {
    const anchor = { x: 100, y: 80 };
    const before = screenToImage(anchor, view);
    const next = zoomAt(view, 1.5, anchor);
    const after = screenToImage(anchor, next);
    expect(next.zoom).toBeCloseTo(3);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
  it("borne le zoom", () => {
    expect(zoomAt({ zoom: 60, panX: 0, panY: 0 }, 10, { x: 0, y: 0 }).zoom).toBe(64);
  });
  it("ajuste sans agrandir au-delà de 100 % et centre", () => {
    expect(fitView(1000, 1000, 100, 100).zoom).toBe(1);
    const v = fitView(500, 400, 2000, 1000, 0);
    expect(v.zoom).toBeCloseTo(0.25);
    expect(v.panX).toBeCloseTo(0);
    expect(v.panY).toBeCloseTo(75);
    expect(centerView(100, 100, 50, 50, 1)).toEqual({ zoom: 1, panX: 25, panY: 25 });
  });
});

describe("rotation des coordonnées", () => {
  it("fait tourner un point d'un quart de tour horaire", () => {
    // image 100×50 : le coin haut-gauche va en haut-droite de l'image 50×100
    expect(rotatePoint({ x: 0, y: 0 }, 100, 50, 1)).toEqual({ x: 50, y: 0 });
    expect(rotatePoint({ x: 100, y: 0 }, 100, 50, 1)).toEqual({ x: 50, y: 100 });
    expect(rotatePoint({ x: 0, y: 0 }, 100, 50, 3)).toEqual({ x: 0, y: 100 });
  });
  it("quatre quarts de tour = identité", () => {
    let r = { x: 10, y: 5, w: 30, h: 20 };
    let w = 100;
    let h = 60;
    for (let i = 0; i < 4; i++) {
      r = rotateRect(r, w, h, 1);
      [w, h] = [h, w];
    }
    expect(r).toEqual({ x: 10, y: 5, w: 30, h: 20 });
  });
  it("tourne un rectangle de recadrage", () => {
    expect(rotateRect({ x: 10, y: 5, w: 30, h: 20 }, 100, 60, 1)).toEqual({
      x: 35,
      y: 10,
      w: 20,
      h: 30,
    });
    expect(rotateRect({ x: 10, y: 5, w: 30, h: 20 }, 100, 60, 2)).toEqual({
      x: 60,
      y: 35,
      w: 30,
      h: 20,
    });
  });
  it("miroirs", () => {
    expect(flipRect({ x: 10, y: 5, w: 30, h: 20 }, 100, 60, "h")).toEqual({
      x: 60,
      y: 5,
      w: 30,
      h: 20,
    });
    expect(flipRect({ x: 10, y: 5, w: 30, h: 20 }, 100, 60, "v")).toEqual({
      x: 10,
      y: 35,
      w: 30,
      h: 20,
    });
  });
});

describe("proportions", () => {
  it("conserve le ratio", () => {
    expect(proportionalSize("width", 400, 800, 600)).toEqual({ width: 400, height: 300 });
    expect(proportionalSize("height", 150, 800, 600)).toEqual({ width: 200, height: 150 });
    expect(proportionalSize("width", 0, 800, 600).width).toBe(1);
  });
  it("calcule un pourcentage", () => {
    expect(percentSize(50, 801, 600)).toEqual({ width: 401, height: 300 });
    expect(percentSize(0.01, 10, 10)).toEqual({ width: 1, height: 1 });
  });
});

describe("rectangle de recadrage", () => {
  const bounds = { w: 200, h: 100 };
  it("redimensionne librement et borne à l'image", () => {
    const r = resizeRect({ x: 10, y: 10, w: 50, h: 50 }, "se", { x: 500, y: 40 }, null, bounds);
    expect(r).toEqual({ x: 10, y: 10, w: 190, h: 30 });
    const l = resizeRect({ x: 10, y: 10, w: 50, h: 50 }, "nw", { x: -20, y: 5 }, null, bounds);
    expect(l).toEqual({ x: 0, y: 5, w: 60, h: 55 });
  });
  it("garde le ratio sur une poignée de coin", () => {
    const r = resizeRect({ x: 0, y: 0, w: 40, h: 40 }, "se", { x: 80, y: 30 }, 1, bounds);
    expect(r.w / r.h).toBeCloseTo(1);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
  it("garde le ratio sur une poignée d'arête et reste dans l'image", () => {
    const r = resizeRect({ x: 50, y: 10, w: 40, h: 30 }, "e", { x: 190, y: 0 }, 16 / 9, bounds);
    expect(r.w / r.h).toBeCloseTo(16 / 9);
    expect(r.x).toBe(50);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y + r.h).toBeLessThanOrEqual(100 + 1e-9);
  });
  it("crée un rectangle dans toutes les directions", () => {
    expect(rectFromDrag({ x: 50, y: 50 }, { x: 20, y: 10 }, null, bounds)).toEqual({
      x: 20,
      y: 10,
      w: 30,
      h: 40,
    });
    const r = rectFromDrag({ x: 50, y: 50 }, { x: 20, y: 40 }, 1, bounds);
    expect(r.w).toBeCloseTo(r.h);
    expect(r.x + r.w).toBeCloseTo(50);
    expect(r.y + r.h).toBeCloseTo(50);
  });
  it("adapte un rectangle à un ratio", () => {
    const r = fitRectToRatio({ x: 0, y: 0, w: 200, h: 100 }, 1, bounds);
    expect(r).toEqual({ x: 50, y: 0, w: 100, h: 100 });
  });
  it("déplace sans sortir et arrondit", () => {
    expect(moveRect({ x: 10, y: 10, w: 50, h: 50 }, 500, -500, bounds)).toEqual({
      x: 150,
      y: 0,
      w: 50,
      h: 50,
    });
    expect(roundRect({ x: 10.4, y: 0.6, w: 50.2, h: 20 }, bounds)).toEqual({
      x: 10,
      y: 1,
      w: 51,
      h: 20,
    });
  });
});
