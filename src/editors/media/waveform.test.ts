import { describe, expect, it } from "vitest";
import { computePeaks, computePeaksAsync, msToX, xToMs } from "./waveform";

describe("computePeaks", () => {
  it("prend le maximum absolu par tranche", () => {
    const data = [0.1, -0.5, 0.2, 0.3, -0.9, 0.0, 0.4, 0.4];
    const peaks = computePeaks([data], 4);
    expect(Array.from(peaks).map((v) => Math.round(v * 10) / 10)).toEqual([0.5, 0.3, 0.9, 0.4]);
  });
  it("combine les canaux", () => {
    const peaks = computePeaks(
      [
        [0.1, 0.1],
        [-0.8, 0.2],
      ],
      2,
    );
    expect(Array.from(peaks).map((v) => Math.round(v * 10) / 10)).toEqual([0.8, 0.2]);
  });
  it("gère plus de tranches que d'échantillons et les données vides", () => {
    expect(computePeaks([[0.5, 0.25]], 4)).toHaveLength(4);
    expect(Array.from(computePeaks([[]], 3))).toEqual([0, 0, 0]);
    expect(computePeaks([], 0)).toHaveLength(0);
  });
  it("plafonne à 1", () => {
    expect(computePeaks([[2, -3]], 1)[0]).toBe(1);
  });
  it("sous-plage", () => {
    const data = [0.1, 0.2, 0.3, 0.4];
    const all = computePeaks([data], 4);
    expect(Array.from(computePeaks([data], 4, 2, 4))).toEqual(Array.from(all.slice(2)));
  });
});

describe("computePeaksAsync", () => {
  it("donne le même résultat que la version synchrone", async () => {
    const data = Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10));
    const sync = computePeaks([data], 450);
    const async = await computePeaksAsync([data], 450, () => false, 100);
    expect(Array.from(async ?? [])).toEqual(Array.from(sync));
  });
  it("s'interrompt si annulé", async () => {
    expect(await computePeaksAsync([[0.1]], 10, () => true)).toBeNull();
  });
});

describe("conversion de coordonnées", () => {
  it("xToMs / msToX", () => {
    expect(xToMs(50, 200, 10000)).toBe(2500);
    expect(xToMs(-10, 200, 10000)).toBe(0);
    expect(xToMs(999, 200, 10000)).toBe(10000);
    expect(msToX(2500, 200, 10000)).toBe(50);
    expect(msToX(5, 200, 0)).toBe(0);
  });
});
