import type { PageRange } from "../../ipc/bindings";

export type RangesError = "empty" | "syntax" | "bounds" | "order";

export type RangesResult = { ok: true; ranges: PageRange[] } | { ok: false; error: RangesError };

/** Analyse « 1-3, 5, 7-9 » (pages 1-based, bornes incluses) pour un document de `pageCount` pages. */
export function parsePageRanges(input: string, pageCount: number): RangesResult {
  const parts = input
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) return { ok: false, error: "empty" };
  const ranges: PageRange[] = [];
  for (const part of parts) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) return { ok: false, error: "syntax" };
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      return { ok: false, error: "bounds" };
    }
    if (start > end) return { ok: false, error: "order" };
    ranges.push({ start, end });
  }
  return { ok: true, ranges };
}
