import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../../ipc/bindings";
import type { KeyValue, MediaDoc } from "../../ipc/bindings";
import { reportError } from "../../shell/errors";
import { basename } from "../../shell/paths";
import { EditorSidePanel, EditorToolbar } from "../../shell/slots";
import { Button } from "../../shell/ui/Button";
import { confirm } from "../../shell/ui/dialogStore";
import { Menu } from "../../shell/ui/Menu";
import { ToolBar, ToolGroup } from "../../shell/ui/ToolBar";
import type { MenuItem } from "../../shell/ui/Menu";
import { pushToast } from "../../shell/ui/toastStore";
import type { EditorProps } from "../types";
import { Player } from "./Player";
import type { Loop } from "./Player";
import { TagsForm } from "./TagsForm";
import { Waveform } from "./Waveform";
import { isTagsReadOnlyMime, isVideoMime, joinTags, splitTags } from "./tags";
import type { NormalizedKey, TagFields } from "./tags";
import { formatTime, parseTime } from "./time";
import styles from "./MediaEditor.module.css";

const AUDIO_FORMATS = ["mp3", "ogg", "flac", "wav", "m4a"];
const VIDEO_FORMATS = ["mp4", "webm"];
const SEEK_MS = 5000;

export default function MediaEditor({
  tab,
  model,
  readOnly,
  setDirty,
  registerSerializer,
  registerCommands,
  setStatus,
}: EditorProps<MediaDoc>) {
  const { t } = useTranslation("media");
  const path = tab.path;
  const isVideo = isVideoMime(model.mime);
  const tagsLocked = readOnly || isTagsReadOnlyMime(model.mime);

  const initial = useMemo(() => splitTags(model.tags), [model.tags]);
  const [fields, setFields] = useState<TagFields>(initial.fields);
  const [extra, setExtra] = useState<KeyValue[]>(initial.extra);
  const dirty = useRef(false);

  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [position, setPosition] = useState(0);
  const [durationMs, setDurationMs] = useState(model.durationMs ?? 0);
  const [loop, setLoop] = useState<Loop>({ a: null, b: null });
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");
  const [cover, setCover] = useState<string | null>(null);
  const [ffmpeg, setFfmpeg] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    registerSerializer(() => ({ ...model, tags: joinTags(model.tags, fields, extra) }));
  }, [registerSerializer, model, fields, extra]);

  function markDirty() {
    if (dirty.current) return;
    dirty.current = true;
    setDirty(true);
  }

  function onField(key: NormalizedKey, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
    markDirty();
  }

  function onExtra(next: KeyValue[]) {
    setExtra(next);
    markDirty();
  }

  useEffect(() => {
    commands
      .mediaFfmpegAvailable()
      .then(setFfmpeg)
      .catch(() => setFfmpeg(false));
  }, []);

  const loadCover = useCallback(async () => {
    if (path === null) return;
    try {
      setCover(await commands.mediaCover(path));
    } catch {
      setCover(null);
    }
  }, [path]);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    commands
      .mediaCover(path)
      .then((c) => {
        if (!cancelled) setCover(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path]);

  const onPosition = useCallback((ms: number) => setPosition(ms), []);

  const seek = useCallback(
    (ms: number) => {
      const media = mediaRef.current;
      if (!media) return;
      const max = durationMs > 0 ? durationMs : ms;
      media.currentTime = Math.max(0, Math.min(max, ms)) / 1000;
      setPosition(media.currentTime * 1000);
    },
    [durationMs],
  );

  useEffect(() => {
    registerCommands([
      {
        id: "media.playPause",
        title: t("commands.playPause"),
        run: () => {
          const media = mediaRef.current;
          if (media) void (media.paused ? media.play().catch(() => undefined) : media.pause());
        },
      },
      {
        id: "media.back",
        title: t("commands.back"),
        run: () => seek((mediaRef.current?.currentTime ?? 0) * 1000 - SEEK_MS),
      },
      {
        id: "media.forward",
        title: t("commands.forward"),
        run: () => seek((mediaRef.current?.currentTime ?? 0) * 1000 + SEEK_MS),
      },
    ]);
  }, [registerCommands, seek, t]);

  useEffect(() => {
    setStatus([
      {
        id: "media-position",
        text: t("status.position", {
          position: formatTime(position, false),
          duration: formatTime(durationMs, false),
        }),
      },
      { id: "media-mime", text: t("status.mime", { mime: model.mime }) },
    ]);
  }, [setStatus, t, position, durationMs, model.mime]);

  // Plage de découpe
  const startMs = parseTime(startText);
  const endMs = parseTime(endText);
  const selection =
    startMs !== null && endMs !== null && endMs > startMs ? { start: startMs, end: endMs } : null;

  function onSelect(start: number, end: number) {
    setStartText(formatTime(start));
    setEndText(formatTime(end));
  }

  async function runTool(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }

  const ext = useMemo(() => {
    const m = /\.([^./\\]+)$/.exec(path ?? "");
    return m?.[1] ?? "";
  }, [path]);
  const base = basename(path ?? "").replace(/\.[^.]+$/, "");

  async function trim() {
    if (path === null) return;
    if (
      startMs === null ||
      endMs === null ||
      endMs <= startMs ||
      (durationMs > 0 && startMs >= durationMs)
    ) {
      pushToast({ kind: "error", text: t("trim.invalid") });
      return;
    }
    const dest = await saveDialog({
      title: t("trim.saveTitle"),
      defaultPath: ext ? `${base}-cut.${ext}` : `${base}-cut`,
    });
    if (dest === null) return;
    await runTool(async () => {
      await commands.mediaTrim(path, startMs, endMs, dest);
      pushToast({ kind: "success", text: t("trim.done", { name: basename(dest) }) });
    });
  }

  async function convert(format: string) {
    if (path === null) return;
    const dest = await saveDialog({
      title: t("convert.saveTitle"),
      defaultPath: `${base}.${format}`,
      filters: [{ name: format, extensions: [format] }],
    });
    if (dest === null) return;
    await runTool(async () => {
      await commands.mediaConvert(path, dest, format);
      pushToast({ kind: "success", text: t("convert.done", { name: basename(dest) }) });
    });
  }

  async function replaceCover() {
    if (path === null || tagsLocked) return;
    const picked = await openDialog({
      title: t("cover.pickTitle"),
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
    });
    if (typeof picked !== "string") return;
    const ok = await confirm({
      title: t("cover.replaceConfirmTitle"),
      message: t("cover.replaceConfirmMessage"),
      confirmLabel: t("cover.replaceConfirm"),
    });
    if (!ok) return;
    await runTool(async () => {
      await commands.mediaSetCover(path, picked);
      await loadCover();
      pushToast({ kind: "success", text: t("cover.done") });
    });
  }

  async function removeCover() {
    if (path === null || tagsLocked) return;
    const ok = await confirm({
      title: t("cover.removeConfirmTitle"),
      message: t("cover.removeConfirmMessage"),
      confirmLabel: t("cover.removeConfirm"),
      danger: true,
    });
    if (!ok) return;
    await runTool(async () => {
      await commands.mediaSetCover(path, null);
      await loadCover();
      pushToast({ kind: "success", text: t("cover.done") });
    });
  }

  const toolsOff = ffmpeg !== true || path === null || busy;
  const ffmpegHint = ffmpeg === false ? t("ffmpeg.hint") : undefined;
  const convertItems: MenuItem[] = [
    { id: "h-audio", label: t("convert.audio"), heading: true },
    ...AUDIO_FORMATS.map((f) => ({ id: f, label: f, onSelect: () => void convert(f) })),
    ...(isVideo
      ? [
          { id: "h-video", label: t("convert.video"), heading: true },
          ...VIDEO_FORMATS.map((f) => ({ id: f, label: f, onSelect: () => void convert(f) })),
        ]
      : []),
  ];

  return (
    <div className={styles.root}>
      <EditorToolbar>
        <ToolBar label={tab.title}>
          <ToolGroup>
            <Button
              variant="ghost"
              icon="trim"
              disabled={toolsOff}
              title={ffmpegHint}
              onClick={() => void trim()}
            >
              {t("trim.apply")}
            </Button>
            <Menu
              label={t("convert.menu")}
              icon="export"
              items={convertItems}
              disabled={toolsOff}
            />
          </ToolGroup>
        </ToolBar>
      </EditorToolbar>

      <EditorSidePanel title={t("info.title")}>
        <dl className={styles.info}>
          <dt>{t("info.mime")}</dt>
          <dd>{model.mime}</dd>
          <dt>{t("info.duration")}</dt>
          <dd>
            {model.durationMs === null && durationMs === 0
              ? t("info.unknown")
              : formatTime(durationMs || (model.durationMs ?? 0))}
          </dd>
          <dt>{t("info.tags")}</dt>
          <dd>{model.tags.length}</dd>
          <dt>{t("info.pictures")}</dt>
          <dd>{model.pictures}</dd>
        </dl>
        <h3 className={styles.subheading}>{t("cover.title")}</h3>
        {cover ? (
          <img className={styles.cover} src={cover} alt={t("cover.alt")} />
        ) : (
          <p className={styles.muted}>{t("cover.none")}</p>
        )}
        <div className={styles.coverActions}>
          <Button
            disabled={tagsLocked || path === null || busy}
            title={tagsLocked ? t("cover.blocked") : undefined}
            onClick={() => void replaceCover()}
          >
            {t("cover.replace")}
          </Button>
          <Button
            variant="danger"
            disabled={tagsLocked || path === null || busy || !cover}
            title={tagsLocked ? t("cover.blocked") : undefined}
            onClick={() => void removeCover()}
          >
            {t("cover.remove")}
          </Button>
        </div>
      </EditorSidePanel>

      <div className={styles.scroll}>
        {ffmpeg === false && (
          <p className={styles.notice} role="note">
            {t("ffmpeg.missing")}
          </p>
        )}
        <Player
          path={path}
          isVideo={isVideo}
          mediaRef={mediaRef}
          durationMs={durationMs}
          onDuration={setDurationMs}
          onPosition={onPosition}
          loop={loop}
          onLoopChange={setLoop}
          selection={selection}
          position={position}
        />
        {!isVideo && path !== null && (
          <Waveform
            path={path}
            durationMs={durationMs}
            position={position}
            selection={selection}
            onSeek={seek}
            onSelect={onSelect}
          />
        )}

        <section className={styles.trim} aria-label={t("trim.title")}>
          <h2 className={styles.heading}>{t("trim.title")}</h2>
          <div className={styles.trimRow}>
            <label className={styles.field}>
              {t("trim.start")}
              <input
                className={styles.input}
                value={startText}
                placeholder="00:00.000"
                aria-invalid={startText !== "" && startMs === null}
                onChange={(e) => setStartText(e.target.value)}
              />
            </label>
            <Button onClick={() => setStartText(formatTime(position))}>
              {t("trim.fromPosition")}
            </Button>
            <label className={styles.field}>
              {t("trim.end")}
              <input
                className={styles.input}
                value={endText}
                placeholder={formatTime(durationMs)}
                aria-invalid={endText !== "" && endMs === null}
                onChange={(e) => setEndText(e.target.value)}
              />
            </label>
            <Button onClick={() => setEndText(formatTime(position))}>
              {t("trim.fromPosition")}
            </Button>
          </div>
        </section>

        <TagsForm
          fields={fields}
          extra={extra}
          readOnly={tagsLocked}
          onField={onField}
          onExtra={onExtra}
        />
      </div>
    </div>
  );
}
