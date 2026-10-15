import { BLOCK_SIZE } from "./blockCache";
import { findInBuffer } from "./format";

/** Borne de la recherche : octets parcourus au maximum. */
export const MAX_SCAN_BYTES = 64 * 1024 * 1024;

export interface SearchResult {
  /** Offset de la première occurrence (≥ `start`), ou `null`. */
  found: number | null;
  /** La borne `maxScan` a été atteinte avant la fin du fichier. */
  truncated: boolean;
}

/** Recherche vers l'avant par blocs, en gérant les motifs à cheval sur deux blocs. */
export async function searchForward(opts: {
  size: number;
  start: number;
  pattern: Uint8Array;
  getBlock: (index: number) => Promise<Uint8Array>;
  maxScan?: number;
  isCancelled?: () => boolean;
}): Promise<SearchResult> {
  const {
    size,
    start,
    pattern,
    getBlock,
    maxScan = MAX_SCAN_BYTES,
    isCancelled = () => false,
  } = opts;
  if (pattern.length === 0 || start >= size) return { found: null, truncated: false };
  const firstBlock = Math.floor(start / BLOCK_SIZE);
  const lastBlock = Math.floor((size - 1) / BLOCK_SIZE);
  let tail: Uint8Array = new Uint8Array(0);
  let scanned = 0;
  for (let b = firstBlock; b <= lastBlock; b++) {
    if (isCancelled()) return { found: null, truncated: false };
    const block = await getBlock(b);
    const base = b * BLOCK_SIZE;
    let chunk = block;
    let chunkBase = base;
    let from = 0;
    if (b === firstBlock) {
      from = start - base;
    } else {
      chunk = new Uint8Array(tail.length + block.length);
      chunk.set(tail, 0);
      chunk.set(block, tail.length);
      chunkBase = base - tail.length;
    }
    const index = findInBuffer(chunk, pattern, from);
    if (index >= 0) return { found: chunkBase + index, truncated: false };
    tail = chunk.slice(Math.max(0, chunk.length - (pattern.length - 1)));
    scanned += block.length;
    if (scanned >= maxScan && b < lastBlock) return { found: null, truncated: true };
  }
  return { found: null, truncated: false };
}
