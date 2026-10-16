import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { commands } from "../../ipc/bindings";
import { readBytes } from "../../ipc/bytes";
import { Button } from "../../shell/ui/Button";
import { formatTime } from "./time";
import styles from "./MediaEditor.module.css";

export interface Loop {
  a: number | null;
  b: number | null;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SKIP_MS = 5000;

interface PlayerProps {
  path: string | null;
  isVideo: boolean;
  mediaRef: RefObject<HTMLMediaElement | null>;
  durationMs: number;
  onDuration(ms: number): void;
  onPosition(ms: number): void;
  loop: Loop;
  onLoopChange(loop: Loop): void;
  /** Plage sélectionnée sur la forme d'onde (pour « boucler la sélection »). */
  selection: { start: number; end: number } | null;
  position: number;
}

export function Player({
  path,
  isVideo,
  mediaRef,
  durationMs,
  onDuration,
  onPosition,
  loop,
  onLoopChange,
  selection,
  position,
}: PlayerProps) {
  const { t } = useTranslation("media");
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (src?.startsWith("blob:")) URL.revokeObjectURL(src);
    },
    [src],
  );
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const loopRef = useRef(loop);
  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    commands
      .allowAsset(path)
      .then(() => {
        if (!cancelled) setSrc(convertFileSrc(path));
      })
      .catch(() => {
        if (!cancelled) setError(t("player.failed"));
      });
    return () => {
      cancelled = true;
    };
  }, [path, t]);

  // Position fluide pendant la lecture + application de la boucle A-B
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const media = mediaRef.current;
      if (media) {
        const { a, b } = loopRef.current;
        if (a !== null && b !== null && b > a && media.currentTime * 1000 >= b) {
          media.currentTime = a / 1000;
        }
        onPosition(media.currentTime * 1000);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, mediaRef, onPosition]);

  const seekTo = useCallback(
    (ms: number) => {
      const media = mediaRef.current;
      if (!media) return;
      const max = durationMs > 0 ? durationMs : ms;
      const clamped = Math.max(0, Math.min(max, ms));
      media.currentTime = clamped / 1000;
      onPosition(clamped);
    },
    [mediaRef, durationMs, onPosition],
  );

  const togglePlay = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) media.play().catch(() => setError(t("player.unsupported")));
    else media.pause();
  }, [mediaRef, t]);

  function onKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const media = mediaRef.current;
    if (e.key === " ") togglePlay();
    else if (e.key === "ArrowLeft" && media) seekTo(media.currentTime * 1000 - SKIP_MS);
    else if (e.key === "ArrowRight" && media) seekTo(media.currentTime * 1000 + SKIP_MS);
    else return;
    e.preventDefault();
  }

  function onMediaError() {
    const code = mediaRef.current?.error?.code;
    // WebKitGTK ne lit pas toujours les médias servis par le protocole asset :
    // repli unique sur une URL blob construite depuis les octets.
    if (path !== null && src !== null && !src.startsWith("blob:")) {
      readBytes(path)
        .then((bytes) => setSrc(URL.createObjectURL(new Blob([bytes]))))
        .catch(() => setError(t("player.failed")));
      return;
    }
    // 3 = MEDIA_ERR_DECODE, 4 = MEDIA_ERR_SRC_NOT_SUPPORTED
    setError(code === 3 || code === 4 ? t("player.unsupported") : t("player.failed"));
  }

  function cycleLoop() {
    const now = position;
    if (loop.a === null) onLoopChange({ a: now, b: null });
    else if (loop.b === null) {
      onLoopChange(now > loop.a ? { a: loop.a, b: now } : { a: now, b: loop.a });
    } else onLoopChange({ a: null, b: null });
  }

  function toggleFullscreen() {
    const el = wrapperRef.current?.querySelector("video");
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => undefined);
  }

  const loopLabel =
    loop.a === null
      ? t("player.loopA")
      : loop.b === null
        ? t("player.loopB")
        : t("player.loopClear", { a: formatTime(loop.a), b: formatTime(loop.b) });
  const loopText = loop.a === null ? "A" : loop.b === null ? "B" : "A-B ✕";

  const mediaProps = {
    src: src ?? undefined,
    preload: "metadata" as const,
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onError: onMediaError,
    onLoadedMetadata: () => {
      const d = mediaRef.current?.duration;
      if (d && Number.isFinite(d)) onDuration(d * 1000);
    },
    onTimeUpdate: () => onPosition((mediaRef.current?.currentTime ?? 0) * 1000),
  };

  return (
    <div
      ref={wrapperRef}
      className={styles.player}
      role="group"
      aria-label={t("player.label")}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {path === null ? (
        <p className={styles.errorBox} role="alert">
          {t("player.noPath")}
        </p>
      ) : isVideo ? (
        <video
          ref={mediaRef as RefObject<HTMLVideoElement | null>}
          className={styles.video}
          onClick={togglePlay}
          {...mediaProps}
        />
      ) : (
        <audio ref={mediaRef as RefObject<HTMLAudioElement | null>} {...mediaProps} />
      )}
      {error && (
        <p className={styles.errorBox} role="alert">
          {error}
        </p>
      )}
      <div className={styles.controls}>
        <IconButtonText
          label={playing ? t("player.pause") : t("player.play")}
          text={playing ? "⏸" : "▶"}
          onClick={togglePlay}
          pressed={playing}
        />
        <IconButtonText
          label={t("player.back")}
          text="−5"
          onClick={() => seekTo(position - SKIP_MS)}
        />
        <IconButtonText
          label={t("player.forward")}
          text="+5"
          onClick={() => seekTo(position + SKIP_MS)}
        />
        <input
          type="range"
          className={styles.seek}
          aria-label={t("player.seek")}
          min={0}
          max={Math.max(1, Math.round(durationMs))}
          step={100}
          value={Math.min(Math.round(position), Math.max(1, Math.round(durationMs)))}
          aria-valuetext={`${formatTime(position, false)} / ${formatTime(durationMs, false)}`}
          onChange={(e) => seekTo(Number(e.target.value))}
        />
        <span className={styles.time}>
          {formatTime(position, false)} / {formatTime(durationMs, false)}
        </span>
        <IconButtonText
          label={muted ? t("player.unmute") : t("player.mute")}
          text={muted || volume === 0 ? "🔇" : "🔊"}
          pressed={muted}
          onClick={() => {
            const next = !muted;
            setMuted(next);
            if (mediaRef.current) mediaRef.current.muted = next;
          }}
        />
        <input
          type="range"
          className={styles.volume}
          aria-label={t("player.volume")}
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            if (mediaRef.current) mediaRef.current.volume = v;
          }}
        />
        <select
          className={styles.select}
          aria-label={t("player.speed")}
          value={speed}
          onChange={(e) => {
            const v = Number(e.target.value);
            setSpeed(v);
            if (mediaRef.current) mediaRef.current.playbackRate = v;
          }}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          aria-label={loopLabel}
          title={loopLabel}
          aria-pressed={loop.a !== null && loop.b !== null}
          onClick={cycleLoop}
        >
          {loopText}
        </Button>
        <Button
          variant="ghost"
          disabled={selection === null}
          title={t("player.loopSelection")}
          aria-label={t("player.loopSelection")}
          onClick={() => selection && onLoopChange({ a: selection.start, b: selection.end })}
        >
          ⟲
        </Button>
        {isVideo && (
          <IconButtonText label={t("player.fullscreen")} text="⛶" onClick={toggleFullscreen} />
        )}
      </div>
      <p className={styles.hint}>{t("player.shortcuts")}</p>
    </div>
  );
}

/** Bouton compact à glyphe texte (les icônes du shell ne couvrent pas la lecture). */
function IconButtonText({
  label,
  text,
  onClick,
  pressed,
}: {
  label: string;
  text: string;
  onClick(): void;
  pressed?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <span aria-hidden="true">{text}</span>
    </Button>
  );
}
