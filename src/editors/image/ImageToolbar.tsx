import { useTranslation } from "react-i18next";
import { EditorToolbar } from "../../shell/slots";
import { Button, IconButton } from "../../shell/ui/Button";
import { RATIOS } from "./geometry";
import type { RatioKey } from "./geometry";
import { DEFAULT_OPTIONS, FONTS, TOOLS } from "./tools";
import type { Tool, ToolOptions } from "./tools";
import styles from "./ImageToolbar.module.css";

export interface ImageToolbarActions {
  undo(): void;
  redo(): void;
  rotate(turns: 1 | 2 | 3): void;
  flip(axis: "h" | "v"): void;
  resize(): void;
  adjust(): void;
  applyCrop(): void;
  cancelCrop(): void;
  save(): void;
  saveAs(): void;
  exportPng(): void;
  stripMetadata(): void;
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  actualSize(): void;
}

interface Props {
  tool: Tool;
  setTool(t: Tool): void;
  options: ToolOptions;
  setOptions(o: ToolOptions): void;
  ratio: RatioKey;
  setRatio(r: RatioKey): void;
  canUndo: boolean;
  canRedo: boolean;
  readOnly: boolean;
  isSvg: boolean;
  canSave: boolean;
  canStrip: boolean;
  hasCrop: boolean;
  zoomLabel: string;
  actions: ImageToolbarActions;
}

export function ImageToolbar(p: Props) {
  const { t } = useTranslation("image");
  const a = p.actions;
  const ro = p.readOnly;
  const showStroke = p.tool !== "select" && p.tool !== "crop";
  const showText = p.tool === "text";

  return (
    <EditorToolbar>
      <div className={styles.bar} role="toolbar" aria-label={t("toolbar.label")}>
        <div className={styles.group}>
          <IconButton
            icon="save"
            label={t("toolbar.save")}
            disabled={!p.canSave}
            onClick={a.save}
          />
          <IconButton icon="saveAs" label={t("toolbar.saveAs")} onClick={a.saveAs} />
          {p.isSvg && (
            <IconButton icon="export" label={t("toolbar.exportPng")} onClick={a.exportPng} />
          )}
          <Button variant="ghost" disabled={!p.canStrip} onClick={a.stripMetadata}>
            {t("toolbar.stripMetadata")}
          </Button>
        </div>
        <div className={styles.group}>
          <Button variant="ghost" disabled={ro || !p.canUndo} onClick={a.undo}>
            {t("toolbar.undo")}
          </Button>
          <Button variant="ghost" disabled={ro || !p.canRedo} onClick={a.redo}>
            {t("toolbar.redo")}
          </Button>
        </div>
        <div className={styles.group} role="group" aria-label={t("toolbar.tools")}>
          {TOOLS.map((tool) => (
            <Button
              key={tool}
              variant="ghost"
              className={styles.tool}
              aria-pressed={p.tool === tool}
              disabled={ro && tool !== "select"}
              onClick={() => p.setTool(tool)}
            >
              {t(`tools.${tool}`)}
            </Button>
          ))}
        </div>
        <div className={styles.group} role="group" aria-label={t("toolbar.transform")}>
          <Button variant="ghost" disabled={ro} onClick={() => a.rotate(1)}>
            {t("toolbar.rotateRight")}
          </Button>
          <Button variant="ghost" disabled={ro} onClick={() => a.rotate(3)}>
            {t("toolbar.rotateLeft")}
          </Button>
          <Button variant="ghost" disabled={ro} onClick={() => a.rotate(2)}>
            {t("toolbar.rotate180")}
          </Button>
          <Button variant="ghost" disabled={ro} onClick={() => a.flip("h")}>
            {t("toolbar.flipH")}
          </Button>
          <Button variant="ghost" disabled={ro} onClick={() => a.flip("v")}>
            {t("toolbar.flipV")}
          </Button>
          <Button variant="ghost" disabled={ro} onClick={a.resize}>
            {t("toolbar.resize")}
          </Button>
          <Button variant="ghost" disabled={ro} onClick={a.adjust}>
            {t("toolbar.adjust")}
          </Button>
        </div>
        {p.tool === "crop" && (
          <div className={styles.group} role="group" aria-label={t("toolbar.cropOptions")}>
            <label className={styles.option}>
              <span>{t("crop.ratio")}</span>
              <select value={p.ratio} onChange={(e) => p.setRatio(e.target.value as RatioKey)}>
                {(Object.keys(RATIOS) as RatioKey[]).map((r) => (
                  <option key={r} value={r}>
                    {r === "free" ? t("crop.free") : r}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="primary" disabled={!p.hasCrop || ro} onClick={a.applyCrop}>
              {t("crop.apply")}
            </Button>
            <Button disabled={!p.hasCrop} onClick={a.cancelCrop}>
              {t("crop.cancel")}
            </Button>
          </div>
        )}
        {(showStroke || showText) && (
          <div className={styles.group} role="group" aria-label={t("toolbar.annotationOptions")}>
            <label className={styles.option}>
              <span>{t("options.color")}</span>
              <input
                type="color"
                value={p.options.color}
                onChange={(e) => p.setOptions({ ...p.options, color: e.target.value })}
              />
            </label>
            {!showText && (
              <label className={styles.option}>
                <span>{t("options.width")}</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={p.options.width}
                  onChange={(e) =>
                    p.setOptions({
                      ...p.options,
                      width: Math.max(1, Number(e.target.value) || DEFAULT_OPTIONS.width),
                    })
                  }
                />
              </label>
            )}
            {showText && (
              <>
                <label className={styles.option}>
                  <span>{t("options.font")}</span>
                  <select
                    value={p.options.font}
                    onChange={(e) => p.setOptions({ ...p.options, font: e.target.value })}
                  >
                    {FONTS.map((f) => (
                      <option key={f} value={f}>
                        {t(`fonts.${f}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.option}>
                  <span>{t("options.size")}</span>
                  <input
                    type="number"
                    min={6}
                    max={400}
                    value={p.options.fontSize}
                    onChange={(e) =>
                      p.setOptions({
                        ...p.options,
                        fontSize: Math.max(6, Number(e.target.value) || DEFAULT_OPTIONS.fontSize),
                      })
                    }
                  />
                </label>
              </>
            )}
          </div>
        )}
        <div className={styles.group} role="group" aria-label={t("toolbar.zoom")}>
          <Button variant="ghost" onClick={a.zoomOut} aria-label={t("toolbar.zoomOut")}>
            −
          </Button>
          <span className={styles.zoom} aria-live="polite">
            {p.zoomLabel}
          </span>
          <Button variant="ghost" onClick={a.zoomIn} aria-label={t("toolbar.zoomIn")}>
            +
          </Button>
          <Button variant="ghost" onClick={a.fit}>
            {t("toolbar.fit")}
          </Button>
          <Button variant="ghost" onClick={a.actualSize}>
            100 %
          </Button>
        </div>
        {ro && <span className={styles.badge}>{t("toolbar.readOnly")}</span>}
      </div>
    </EditorToolbar>
  );
}
