import { useTranslation } from "react-i18next";
import type { ExifEntry } from "../../ipc/bindings";
import { EditorSidePanel } from "../../shell/slots";
import { Button } from "../../shell/ui/Button";
import { formatBytes } from "./formats";
import { opLabelKey } from "./ops";
import type { OpStack } from "./ops";
import styles from "./ImagePanel.module.css";

interface Props {
  width: number;
  height: number;
  format: string;
  hasAlpha: boolean;
  fileSize: number | null;
  exif: ExifEntry[];
  stack: OpStack;
  canStrip: boolean;
  onStrip(): void;
  onJump(cursor: number): void;
}

export function ImagePanel(p: Props) {
  const { t } = useTranslation("image");
  return (
    <EditorSidePanel title={t("panel.title")}>
      <h3 className={styles.heading}>{t("panel.info")}</h3>
      <dl className={styles.info}>
        <dt>{t("panel.dimensions")}</dt>
        <dd>
          {p.width} × {p.height}
        </dd>
        <dt>{t("panel.format")}</dt>
        <dd>{p.format.toUpperCase()}</dd>
        <dt>{t("panel.alpha")}</dt>
        <dd>{p.hasAlpha ? t("panel.yes") : t("panel.no")}</dd>
        <dt>{t("panel.fileSize")}</dt>
        <dd>{p.fileSize === null ? "…" : formatBytes(p.fileSize)}</dd>
      </dl>

      <h3 className={styles.heading}>{t("panel.exif")}</h3>
      {p.exif.length === 0 ? (
        <p className={styles.muted}>{t("panel.noExif")}</p>
      ) : (
        <table className={styles.exif}>
          <thead>
            <tr>
              <th scope="col">{t("panel.exifTag")}</th>
              <th scope="col">{t("panel.exifValue")}</th>
            </tr>
          </thead>
          <tbody>
            {p.exif.map((e, i) => (
              <tr key={`${e.tag}-${i}`}>
                <th scope="row">{e.tag}</th>
                <td>{e.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Button disabled={!p.canStrip} onClick={p.onStrip}>
        {t("toolbar.stripMetadata")}
      </Button>

      <h3 className={styles.heading}>{t("panel.history")}</h3>
      <ol className={styles.history} aria-label={t("panel.history")}>
        <li>
          <button
            type="button"
            className={styles.step}
            aria-current={p.stack.cursor === 0 ? "step" : undefined}
            onClick={() => p.onJump(0)}
          >
            {t("history.original")}
          </button>
        </li>
        {p.stack.ops.map((op, i) => (
          <li key={i} className={i >= p.stack.cursor ? styles.undone : undefined}>
            <button
              type="button"
              className={styles.step}
              aria-current={p.stack.cursor === i + 1 ? "step" : undefined}
              onClick={() => p.onJump(i + 1)}
            >
              {t(opLabelKey(op))}
            </button>
          </li>
        ))}
      </ol>
    </EditorSidePanel>
  );
}
