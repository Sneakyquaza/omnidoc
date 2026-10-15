import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { readRange } from "../../ipc/bytes";
import { MAX_WAVEFORM_BYTES, computePeaksAsync, msToX, xToMs } from "./waveform";
import styles from "./MediaEditor.module.css";

const BUCKETS = 2000;
const CHUNK = 1024 * 1024;
const HEIGHT = 96;
const DRAG_THRESHOLD = 3;

type Status = "loading" | "ready" | "tooLarge" | "failed";

/** Lit le fichier par blocs de 1 Mio ; `null` s'il dépasse la taille maximale. */
async function readLimited(path: string, isCancelled: () => boolean): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = new Uint8Array(await readRange(path, total, CHUNK));
    if (isCancelled()) return null;
    if (chunk.length === 0) break;
    parts.push(chunk);
    total += chunk.length;
    if (total > MAX_WAVEFORM_BYTES) return null;
    if (chunk.length < CHUNK) break;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

interface WaveformProps {
  path: string;
  durationMs: number;
  position: number;
  selection: { start: number; end: number } | null;
  onSeek(ms: number): void;
  onSelect(start: number, end: number): void;
}

export function Waveform({
  path,
  durationMs,
  position,
  selection,
  onSeek,
  onSelect,
}: WaveformProps) {
  const { t } = useTranslation("media");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [width, setWidth] = useState(600);
  const drag = useRef<{ x0: number; moved: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bytes = await readLimited(path, () => cancelled);
        if (cancelled) return;
        if (bytes === null) {
          setStatus("tooLarge");
          return;
        }
        const ctx = new OfflineAudioContext(1, 1, 44100);
        const buffer = await ctx.decodeAudioData(bytes.buffer as ArrayBuffer);
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
          buffer.getChannelData(i),
        );
        const result = await computePeaksAsync(channels, BUCKETS, () => cancelled);
        if (cancelled || result === null) return;
        setPeaks(result);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(100, el.clientWidth)));
    observer.observe(el);
    setWidth(Math.max(100, el.clientWidth));
    return () => observer.disconnect();
  }, [status]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext("2d");
    if (!canvas || !g || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(HEIGHT * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const accent = css.getPropertyValue("--color-accent").trim() || "#2563eb";
    const muted = css.getPropertyValue("--color-text-muted").trim() || "#888";
    const text = css.getPropertyValue("--color-text").trim() || "#000";
    g.clearRect(0, 0, width, HEIGHT);

    if (selection && durationMs > 0) {
      const x1 = msToX(selection.start, width, durationMs);
      const x2 = msToX(selection.end, width, durationMs);
      g.globalAlpha = 0.25;
      g.fillStyle = accent;
      g.fillRect(x1, 0, Math.max(1, x2 - x1), HEIGHT);
      g.globalAlpha = 1;
    }

    const mid = HEIGHT / 2;
    g.fillStyle = muted;
    for (let x = 0; x < width; x++) {
      const peak = peaks[Math.min(peaks.length - 1, Math.floor((x / width) * peaks.length))] ?? 0;
      const h = Math.max(1, peak * (HEIGHT - 4));
      g.fillRect(x, mid - h / 2, 1, h);
    }

    if (durationMs > 0) {
      const px = Math.round(msToX(position, width, durationMs));
      g.fillStyle = text;
      g.fillRect(px, 0, 2, HEIGHT);
    }
  }, [peaks, width, position, selection, durationMs]);

  if (status !== "ready") {
    return (
      <p className={styles.waveformStatus} role="status">
        {t(`waveform.${status}`)}
      </p>
    );
  }

  const localX = (e: PointerEvent) => e.clientX - e.currentTarget.getBoundingClientRect().left;

  return (
    <div ref={wrapRef} className={styles.waveform}>
      <canvas
        ref={canvasRef}
        style={{ width, height: HEIGHT }}
        role="img"
        aria-label={t("waveform.label")}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x0: localX(e), moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const x = localX(e);
          if (!d.moved && Math.abs(x - d.x0) < DRAG_THRESHOLD) return;
          d.moved = true;
          const a = xToMs(d.x0, width, durationMs);
          const b = xToMs(x, width, durationMs);
          onSelect(Math.min(a, b), Math.max(a, b));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) onSeek(xToMs(localX(e), width, durationMs));
        }}
      />
    </div>
  );
}
