/** Taille maximale (en octets) d'un fichier dont on calcule la forme d'onde. */
export const MAX_WAVEFORM_BYTES = 50 * 1024 * 1024;

/**
 * Pics (amplitude absolue maximale, tous canaux confondus, 0–1) par tranche,
 * pour les tranches `[from, to)` sur `buckets` au total.
 */
export function computePeaks(
  channels: ArrayLike<number>[],
  buckets: number,
  from = 0,
  to = buckets,
): Float32Array {
  const out = new Float32Array(Math.max(0, to - from));
  const length = channels.reduce((max, c) => Math.max(max, c.length), 0);
  if (length === 0 || buckets <= 0) return out;
  for (let b = from; b < to; b++) {
    const start = Math.floor((b * length) / buckets);
    const end = Math.max(start + 1, Math.floor(((b + 1) * length) / buckets));
    let peak = 0;
    for (const channel of channels) {
      const stop = Math.min(end, channel.length);
      for (let i = start; i < stop; i++) {
        const v = Math.abs(channel[i] ?? 0);
        if (v > peak) peak = v;
      }
    }
    out[b - from] = Math.min(1, peak);
  }
  return out;
}

/** Même calcul, par tranches de `chunk` pics, en rendant la main entre deux (UI fluide). */
export async function computePeaksAsync(
  channels: ArrayLike<number>[],
  buckets: number,
  isCancelled: () => boolean,
  chunk = 200,
): Promise<Float32Array | null> {
  const out = new Float32Array(buckets);
  for (let from = 0; from < buckets; from += chunk) {
    if (isCancelled()) return null;
    const to = Math.min(buckets, from + chunk);
    out.set(computePeaks(channels, buckets, from, to), from);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return out;
}

/** Position (ms) correspondant à une abscisse en pixels. */
export function xToMs(x: number, width: number, durationMs: number): number {
  if (width <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, x / width)) * durationMs);
}

/** Abscisse (pixels) d'une position en ms. */
export function msToX(ms: number, width: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.max(0, Math.min(1, ms / durationMs)) * width;
}
