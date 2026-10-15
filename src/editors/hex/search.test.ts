import { describe, expect, it } from "vitest";
import { BLOCK_SIZE, BlockCache } from "./blockCache";
import { searchForward } from "./search";

function source(size: number, patches: Record<number, number[]>) {
  const data = new Uint8Array(size);
  for (const [at, bytes] of Object.entries(patches)) data.set(bytes, Number(at));
  return {
    data,
    getBlock: async (i: number) => data.slice(i * BLOCK_SIZE, Math.min((i + 1) * BLOCK_SIZE, size)),
  };
}

describe("recherche dans les blocs", () => {
  it("trouve un motif à cheval sur deux blocs", async () => {
    const at = BLOCK_SIZE - 2;
    const { getBlock } = source(BLOCK_SIZE * 2 + 10, { [at]: [9, 8, 7, 6] });
    const r = await searchForward({
      size: BLOCK_SIZE * 2 + 10,
      start: 0,
      pattern: new Uint8Array([9, 8, 7, 6]),
      getBlock,
    });
    expect(r.found).toBe(at);
  });

  it("respecte l'offset de départ et signale l'absence", async () => {
    const { getBlock } = source(100, { 10: [5, 5], 50: [5, 5] });
    const pattern = new Uint8Array([5, 5]);
    expect((await searchForward({ size: 100, start: 11, pattern, getBlock })).found).toBe(50);
    expect((await searchForward({ size: 100, start: 51, pattern, getBlock })).found).toBeNull();
  });

  it("borne le volume parcouru", async () => {
    const size = BLOCK_SIZE * 4;
    const { getBlock } = source(size, {});
    const r = await searchForward({
      size,
      start: 0,
      pattern: new Uint8Array([1]),
      getBlock,
      maxScan: BLOCK_SIZE,
    });
    expect(r).toEqual({ found: null, truncated: true });
  });
});

describe("cache de blocs", () => {
  it("évince le bloc le moins récemment utilisé et dédoublonne les requêtes", async () => {
    let calls = 0;
    const cache = new BlockCache(async (i) => (calls++, new Uint8Array([i])), 2);
    await Promise.all([cache.load(0), cache.load(0)]);
    expect(calls).toBe(1);
    await cache.load(1);
    cache.get(0);
    await cache.load(2);
    expect(cache.peek(1)).toBeUndefined();
    expect(cache.peek(0)).toBeDefined();
    expect(cache.size).toBe(2);
  });
});
