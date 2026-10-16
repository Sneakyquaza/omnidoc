import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../../ipc/bindings";
import type { ImageDoc } from "../../ipc/bindings";
import { readBytes } from "../../ipc/bytes";
import { basename } from "../../shell/paths";
import { reportError } from "../../shell/errors";
import { confirm } from "../../shell/ui/dialogStore";
import { pushToast } from "../../shell/ui/toastStore";
import type { EditorProps } from "../types";
import { AdjustDialog, QualityDialog, ResizeDialog, ScaleDialog } from "./Dialogs";
import { ImagePanel } from "./ImagePanel";
import { ImageToolbar } from "./ImageToolbar";
import type { ImageToolbarActions } from "./ImageToolbar";
import { Viewport } from "./Viewport";
import type { Annotation } from "./annotations";
import { SAVE_FORMATS, formatFromPath, isLossy, saveFormatOf, toHex } from "./formats";
import type { SaveFormat } from "./formats";
import {
  RATIOS,
  centerView,
  fitRectToRatio,
  flipRect,
  fitView,
  roundRect,
  rotateRect,
  zoomAt,
} from "./geometry";
import type { Point, Rect, RatioKey, Size, View } from "./geometry";
import {
  activeOps,
  canRedo,
  canUndo,
  createStack,
  isDirty,
  jumpTo,
  liveAnnotations,
  markSaved,
  pushOp,
  redo,
  undo,
} from "./ops";
import type { AdjustParams, Op } from "./ops";
import { canvasToPngBase64, flatten, opsKey, renderOps, splitOps } from "./render";
import { loadSource } from "./source";
import { DEFAULT_OPTIONS } from "./tools";
import type { Tool, ToolOptions } from "./tools";
import styles from "./ImageEditor.module.css";

type DialogState =
  | null
  | { kind: "resize" }
  | { kind: "adjust" }
  | { kind: "exportPng" }
  | { kind: "quality"; dest: string; format: SaveFormat };

const DEFAULT_QUALITY = 90;

function adjustFilter(p: AdjustParams): string {
  const gray = p.grayscale ? " grayscale(1)" : "";
  return `brightness(${1 + p.brightness / 100}) contrast(${1 + p.contrast / 100}) saturate(${1 + p.saturation / 100})${gray}`;
}

export default function ImageEditor({
  tab,
  model,
  setDirty,
  registerSerializer,
  registerCommands,
  registerSaveHandler,
  setEditable,
  setStatus,
}: EditorProps<ImageDoc>) {
  const { t } = useTranslation("image");
  const path = tab.path;
  // Le handler « image » n'écrit pas via save_document (write: false → tab.readOnly toujours vrai) :
  // l'édition et l'enregistrement passent par les commandes image_* de cet éditeur.
  const readOnly = false;
  const isSvg = model.format === "svg";

  const [source, setSource] = useState<HTMLCanvasElement | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [exif, setExif] = useState(model.exif);
  const [stack, setStack] = useState(createStack);
  const [tool, setToolState] = useState<Tool>("select");
  const [options, setOptions] = useState<ToolOptions>(DEFAULT_OPTIONS);
  const [ratioKey, setRatioKey] = useState<RatioKey>("free");
  const [crop, setCrop] = useState<Rect | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [vsize, setVsize] = useState<Size>({ w: 0, h: 0 });
  const [custom, setCustom] = useState<{ key: string; view: View } | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [preview, setPreview] = useState<AdjustParams | null>(null);
  const reencodeConfirmed = useRef(false);

  // Le modèle n'embarque pas les pixels : le shell sérialise le modèle d'origine.
  useEffect(() => {
    registerSerializer(() => model);
  }, [registerSerializer, model]);

  // Chargement des pixels
  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    loadSource(path, model.format, model)
      .then((s) => {
        if (cancelled) return;
        setSource(s.canvas);
        setFileSize(s.fileSize);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, model]);

  // Rendu des opérations « pixels » (mis en cache par identité des opérations)
  const active = activeOps(stack);
  const headKey = opsKey(splitOps(active).head);
  const base = useMemo(
    () => (source ? renderOps(source, splitOps(activeOps(stack)).head).canvas : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, headKey],
  );
  const live = liveAnnotations(active);
  const dirty = isDirty(stack);

  useEffect(() => {
    setDirty(dirty);
  }, [dirty, setDirty]);

  // Vue : ajustée par défaut, personnalisée tant que les dimensions ne changent pas
  const dimsKey = base ? `${base.width}x${base.height}` : "";
  const view: View | null =
    base && vsize.w > 0 && vsize.h > 0
      ? custom && custom.key === dimsKey
        ? custom.view
        : fitView(vsize.w, vsize.h, base.width, base.height)
      : null;
  const setView = useCallback((v: View) => setCustom({ key: dimsKey, view: v }), [dimsKey]);

  // Barre d'état
  useEffect(() => {
    if (!base) {
      setStatus([]);
      return;
    }
    const items = [
      { id: "image-size", text: `${base.width} × ${base.height} px` },
      { id: "image-zoom", text: `${Math.round((view?.zoom ?? 1) * 100)} %` },
    ];
    if (
      cursor &&
      cursor.x >= 0 &&
      cursor.y >= 0 &&
      cursor.x < base.width &&
      cursor.y < base.height
    ) {
      const x = Math.floor(cursor.x);
      const y = Math.floor(cursor.y);
      items.push({ id: "image-pos", text: `${x}, ${y}` });
      const px = base.getContext("2d")?.getImageData(x, y, 1, 1).data;
      if (px) {
        const [r = 0, g = 0, b = 0, a = 255] = px;
        const alpha = a === 255 ? "" : ` · α ${Math.round((a / 255) * 100)} %`;
        items.push({ id: "image-color", text: `${toHex(r, g, b)}${alpha}` });
      }
    }
    setStatus(items);
  }, [base, view?.zoom, cursor, setStatus]);

  const bounds: Size = { w: base?.width ?? 0, h: base?.height ?? 0 };
  const ratio = RATIOS[ratioKey];

  function commit(op: Op, keepSelection = false) {
    setStack((s) => pushOp(s, op));
    if (!keepSelection) setSelectedId(null);
  }

  function setTool(next: Tool) {
    setToolState(next);
    if (next === "crop" && base && !crop) {
      const full = { x: 0, y: 0, w: base.width, h: base.height };
      setCrop(ratio === null ? full : fitRectToRatio(full, ratio, bounds));
    } else if (next !== "crop") {
      setCrop(null);
    }
  }

  function changeRatio(key: RatioKey) {
    setRatioKey(key);
    const r = RATIOS[key];
    if (crop && r !== null) setCrop(fitRectToRatio(crop, r, bounds));
  }

  function rotate(turns: 1 | 2 | 3) {
    if (!base || readOnly) return;
    if (crop) setCrop(rotateRect(crop, base.width, base.height, turns));
    commit({ type: "rotate", turns });
  }

  function flip(axis: "h" | "v") {
    if (!base || readOnly) return;
    if (crop) setCrop(flipRect(crop, base.width, base.height, axis));
    commit({ type: "flip", axis });
  }

  function applyCrop() {
    if (!crop || !base || readOnly) return;
    commit({ type: "crop", rect: roundRect(crop, bounds) });
    setCrop(null);
    setToolState("select");
  }

  function cancelCrop() {
    setCrop(null);
  }

  function doUndo() {
    if (readOnly) return;
    setStack(undo);
    setCrop(null);
    setSelectedId(null);
  }

  function doRedo() {
    if (readOnly) return;
    setStack(redo);
    setCrop(null);
    setSelectedId(null);
  }

  // --- Enregistrement ---------------------------------------------------

  async function refreshFileSize() {
    if (path === null) return;
    try {
      setFileSize((await readBytes(path)).byteLength);
    } catch {
      /* taille purement informative */
    }
  }

  function exportCanvas(): HTMLCanvasElement | null {
    return base ? flatten(base, live) : null;
  }

  async function writeTo(
    dest: string,
    format: SaveFormat,
    quality: number | null,
  ): Promise<boolean> {
    try {
      if (!dirty && stack.cursor === 0 && path !== null && !isSvg) {
        // Aucune modification : conversion fidèle du fichier d'origine
        await commands.imageConvert(path, dest, format, quality);
      } else {
        const canvas = exportCanvas();
        if (!canvas) return false;
        await commands.imageSave(dest, canvasToPngBase64(canvas), format, quality);
      }
      if (dest === path) {
        setStack(markSaved);
        setDirty(false);
        setExif([]);
        void refreshFileSize();
      }
      pushToast({ kind: "success", text: t("save.done", { name: basename(dest) }) });
      return true;
    } catch (e) {
      reportError(e);
      return false;
    }
  }

  const canSaveInPlace =
    !readOnly && !isSvg && path !== null && dirty && saveFormatOf(model.format) !== null;

  async function saveInPlace(): Promise<boolean> {
    const format = saveFormatOf(model.format);
    if (!canSaveInPlace || path === null || format === null) return !dirty;
    if (!reencodeConfirmed.current) {
      const ok = await confirm({
        title: t("save.reencodeTitle"),
        message: t("save.reencodeMessage"),
        confirmLabel: t("save.reencodeConfirm"),
        danger: true,
      });
      if (!ok) return false;
      reencodeConfirmed.current = true;
    }
    return writeTo(path, format, isLossy(format) ? DEFAULT_QUALITY : null);
  }

  async function saveAs(): Promise<boolean> {
    if (!base) return false;
    try {
      const current = saveFormatOf(model.format) ?? "png";
      const ordered = [
        ...SAVE_FORMATS.filter((f) => f.format === current),
        ...SAVE_FORMATS.filter((f) => f.format !== current),
      ];
      const stem = (path ? basename(path) : tab.title).replace(/\.[^.]*$/, "");
      const ext = ordered[0]?.extensions[0] ?? "png";
      const dest = await saveDialog({
        defaultPath: `${stem}.${ext}`,
        filters: ordered.map((f) => ({
          name: f.format.toUpperCase(),
          extensions: [...f.extensions],
        })),
      });
      if (dest === null) return false;
      const format = formatFromPath(dest);
      if (format === null) {
        pushToast({ kind: "error", text: t("save.unsupportedExtension") });
        return false;
      }
      if (isLossy(format)) {
        setDialog({ kind: "quality", dest, format });
        return false;
      }
      return await writeTo(dest, format, null);
    } catch (e) {
      reportError(e);
      return false;
    }
  }

  async function exportSvgPng(scale: number) {
    setDialog(null);
    if (path === null) return;
    try {
      const dest = await saveDialog({
        defaultPath: `${basename(path).replace(/\.[^.]*$/, "")}.png`,
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (dest === null) return;
      await commands.svgRenderPng(path, dest, scale);
      pushToast({ kind: "success", text: t("save.done", { name: basename(dest) }) });
    } catch (e) {
      reportError(e);
    }
  }

  async function stripMetadata() {
    if (path === null || readOnly || isSvg) return;
    const ok = await confirm({
      title: t("strip.title"),
      message: t("strip.message"),
      confirmLabel: t("strip.confirm"),
      danger: true,
    });
    if (!ok) return;
    try {
      await commands.imageStripMetadata(path, path);
      setExif([]);
      void refreshFileSize();
      pushToast({ kind: "success", text: t("strip.done") });
    } catch (e) {
      reportError(e);
    }
  }

  // --- Zoom -------------------------------------------------------------

  function zoomBy(factor: number) {
    if (!view) return;
    setView(zoomAt(view, factor, { x: vsize.w / 2, y: vsize.h / 2 }));
  }

  function actualSize() {
    if (!base || !view) return;
    setView(centerView(vsize.w, vsize.h, base.width, base.height, 1));
  }

  const actions: ImageToolbarActions = {
    undo: doUndo,
    redo: doRedo,
    rotate,
    flip,
    resize: () => setDialog({ kind: "resize" }),
    adjust: () => setDialog({ kind: "adjust" }),
    applyCrop,
    cancelCrop,
    save: () => void saveInPlace(),
    saveAs: () => void saveAs(),
    exportPng: () => setDialog({ kind: "exportPng" }),
    stripMetadata: () => void stripMetadata(),
    zoomIn: () => zoomBy(1.25),
    zoomOut: () => zoomBy(0.8),
    fit: () => setCustom(null),
    actualSize,
  };

  // Les commandes (palette + raccourcis) appellent toujours la dernière version des actions.
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  });
  const saveRef = useRef({ save: saveInPlace, saveAs });
  useEffect(() => {
    saveRef.current = { save: saveInPlace, saveAs };
  });
  useEffect(() => {
    registerSaveHandler({
      save: () => saveRef.current.save(),
      saveAs: () => saveRef.current.saveAs(),
    });
    setEditable(true);
  }, [registerSaveHandler, setEditable]);
  const toolRef = useRef(setTool);
  useEffect(() => {
    toolRef.current = setTool;
  });

  useEffect(() => {
    const run = (name: keyof ImageToolbarActions) => () =>
      (actionsRef.current[name] as () => void)();
    registerCommands([
      { id: "image.undo", title: t("commands.undo"), shortcut: "Mod+Z", run: run("undo") },
      { id: "image.redo", title: t("commands.redo"), shortcut: "Mod+Shift+Z", run: run("redo") },
      { id: "image.strip", title: t("commands.strip"), run: run("stripMetadata") },
      { id: "image.exportPng", title: t("commands.exportPng"), run: run("exportPng") },
      {
        id: "image.rotateRight",
        title: t("commands.rotateRight"),
        shortcut: "Mod+Alt+ArrowRight",
        run: () => actionsRef.current.rotate(1),
      },
      {
        id: "image.rotateLeft",
        title: t("commands.rotateLeft"),
        shortcut: "Mod+Alt+ArrowLeft",
        run: () => actionsRef.current.rotate(3),
      },
      {
        id: "image.rotate180",
        title: t("commands.rotate180"),
        run: () => actionsRef.current.rotate(2),
      },
      { id: "image.flipH", title: t("commands.flipH"), run: () => actionsRef.current.flip("h") },
      { id: "image.flipV", title: t("commands.flipV"), run: () => actionsRef.current.flip("v") },
      {
        id: "image.crop",
        title: t("commands.crop"),
        shortcut: "Mod+Alt+C",
        run: () => toolRef.current("crop"),
      },
      {
        id: "image.resize",
        title: t("commands.resize"),
        shortcut: "Mod+Alt+I",
        run: run("resize"),
      },
      { id: "image.adjust", title: t("commands.adjust"), run: run("adjust") },
      { id: "image.zoomIn", title: t("commands.zoomIn"), shortcut: "Mod+=", run: run("zoomIn") },
      { id: "image.zoomOut", title: t("commands.zoomOut"), shortcut: "Mod+-", run: run("zoomOut") },
      { id: "image.fit", title: t("commands.fit"), shortcut: "Mod+0", run: run("fit") },
      {
        id: "image.actual",
        title: t("commands.actualSize"),
        shortcut: "Mod+1",
        run: run("actualSize"),
      },
    ]);
  }, [registerCommands, t]);

  const onAnnotationsChange = useCallback((items: Annotation[]) => {
    setStack((s) => pushOp(s, { type: "annotations", items }));
  }, []);

  if (path === null || loadFailed) {
    return <div className={styles.message}>{t("loadError")}</div>;
  }
  if (!base) {
    return <div className={styles.message}>{t("loading")}</div>;
  }

  return (
    <div className={styles.root}>
      <ImageToolbar
        tool={tool}
        setTool={setTool}
        options={options}
        setOptions={setOptions}
        ratio={ratioKey}
        setRatio={changeRatio}
        canUndo={canUndo(stack)}
        canRedo={canRedo(stack)}
        readOnly={readOnly}
        isSvg={isSvg}
        canSave={canSaveInPlace}
        canStrip={!readOnly && !isSvg}
        hasCrop={crop !== null}
        zoomLabel={`${Math.round((view?.zoom ?? 1) * 100)} %`}
        actions={actions}
      />
      {isSvg && <div className={styles.note}>{t("svgNote")}</div>}
      <Viewport
        canvas={base}
        annotations={live}
        onAnnotationsChange={onAnnotationsChange}
        tool={tool}
        options={options}
        readOnly={readOnly}
        selectedId={selectedId}
        onSelect={setSelectedId}
        view={view}
        onViewChange={setView}
        onSize={setVsize}
        crop={crop}
        onCropChange={setCrop}
        ratio={ratio}
        onApplyCrop={applyCrop}
        onCursor={setCursor}
        filter={preview ? adjustFilter(preview) : undefined}
      />
      <ImagePanel
        width={model.width}
        height={model.height}
        format={model.format}
        hasAlpha={model.hasAlpha}
        fileSize={fileSize}
        exif={exif}
        stack={stack}
        canStrip={!readOnly && !isSvg}
        onStrip={() => void stripMetadata()}
        onJump={(c) => {
          if (readOnly) return;
          setStack((s) => jumpTo(s, c));
          setCrop(null);
          setSelectedId(null);
        }}
      />
      {dialog?.kind === "resize" && (
        <ResizeDialog
          width={base.width}
          height={base.height}
          onCancel={() => setDialog(null)}
          onApply={(width, height) => {
            setDialog(null);
            setCrop(null);
            if (width !== base.width || height !== base.height) {
              commit({ type: "resize", width, height });
            }
          }}
        />
      )}
      {dialog?.kind === "adjust" && (
        <AdjustDialog
          onChange={setPreview}
          onCancel={() => {
            setPreview(null);
            setDialog(null);
          }}
          onApply={(params) => {
            setPreview(null);
            setDialog(null);
            commit({ type: "adjust", params });
          }}
        />
      )}
      {dialog?.kind === "quality" && (
        <QualityDialog
          format={dialog.format}
          onCancel={() => setDialog(null)}
          onApply={(q) => {
            const { dest, format } = dialog;
            setDialog(null);
            void writeTo(dest, format, q);
          }}
        />
      )}
      {dialog?.kind === "exportPng" && (
        <ScaleDialog
          width={model.width || base.width}
          height={model.height || base.height}
          onCancel={() => setDialog(null)}
          onApply={(s) => void exportSvgPng(s)}
        />
      )}
    </div>
  );
}
