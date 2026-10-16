import { useTranslation } from "react-i18next";
import { EditorToolbar } from "../../shell/slots";
import { Button, IconButton } from "../../shell/ui/Button";
import type { IconName } from "../../shell/ui/icons";
import { ToolBar, ToolGroup } from "../../shell/ui/ToolBar";
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

const TOOL_ICONS: Record<Tool, IconName> = {
  select: "pointer",
  crop: "crop",
  arrow: "arrowDiag",
  rect: "square",
  ellipse: "circle",
  pen: "pen",
  text: "textColor",
  highlight: "highlight",
};

export function ImageToolbar(p: Props) {
  const { t } = useTranslation("image");
  const a = p.actions;
  const ro = p.readOnly;
  const showStroke = p.tool !== "select" && p.tool !== "crop";
  const showText = p.tool === "text";

  return (
    <EditorToolbar>
      <ToolBar label={t("toolbar.label")}>
        <ToolGroup>
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
          <IconButton
            icon="eraser"
            label={t("toolbar.stripMetadata")}
            disabled={!p.canStrip}
            onClick={a.stripMetadata}
          />
        </ToolGroup>
        <ToolGroup>
          <IconButton
            icon="undo"
            label={t("toolbar.undo")}
            disabled={ro || !p.canUndo}
            onClick={a.undo}
          />
          <IconButton
            icon="redo"
            label={t("toolbar.redo")}
            disabled={ro || !p.canRedo}
            onClick={a.redo}
          />
        </ToolGroup>
        <ToolGroup label={t("toolbar.tools")}>
          {TOOLS.map((tool) => (
            <IconButton
              key={tool}
              icon={TOOL_ICONS[tool]}
              label={t(`tools.${tool}`)}
              pressed={p.tool === tool}
              disabled={ro && tool !== "select"}
              onClick={() => p.setTool(tool)}
            />
          ))}
        </ToolGroup>
        <ToolGroup label={t("toolbar.transform")}>
          <IconButton
            icon="rotateCw"
            label={t("toolbar.rotateRight")}
            disabled={ro}
            onClick={() => a.rotate(1)}
          />
          <IconButton
            icon="rotateCcw"
            label={t("toolbar.rotateLeft")}
            disabled={ro}
            onClick={() => a.rotate(3)}
          />
          <IconButton
            icon="refresh"
            label={t("toolbar.rotate180")}
            disabled={ro}
            onClick={() => a.rotate(2)}
          />
          <IconButton
            icon="flipH"
            label={t("toolbar.flipH")}
            disabled={ro}
            onClick={() => a.flip("h")}
          />
          <IconButton
            icon="flipV"
            label={t("toolbar.flipV")}
            disabled={ro}
            onClick={() => a.flip("v")}
          />
          <IconButton icon="resize" label={t("toolbar.resize")} disabled={ro} onClick={a.resize} />
          <IconButton icon="adjust" label={t("toolbar.adjust")} disabled={ro} onClick={a.adjust} />
        </ToolGroup>
        {p.tool === "crop" && (
          <ToolGroup label={t("toolbar.cropOptions")}>
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
          </ToolGroup>
        )}
        {(showStroke || showText) && (
          <ToolGroup label={t("toolbar.annotationOptions")}>
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
          </ToolGroup>
        )}
        <ToolGroup label={t("toolbar.zoom")}>
          <IconButton icon="zoomOut" label={t("toolbar.zoomOut")} onClick={a.zoomOut} />
          <span className={styles.zoom} aria-live="polite">
            {p.zoomLabel}
          </span>
          <IconButton icon="zoomIn" label={t("toolbar.zoomIn")} onClick={a.zoomIn} />
          <IconButton icon="scan" label={t("toolbar.fit")} onClick={a.fit} />
          <Button variant="ghost" onClick={a.actualSize}>
            100 %
          </Button>
        </ToolGroup>
        {ro && (
          <ToolGroup>
            <span className={styles.badge}>{t("toolbar.readOnly")}</span>
          </ToolGroup>
        )}
      </ToolBar>
    </EditorToolbar>
  );
}
