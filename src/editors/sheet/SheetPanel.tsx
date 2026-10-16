import { useTranslation } from "react-i18next";
import type { CsvOptions } from "../../ipc/bindings";
import styles from "./SheetEditor.module.css";

const DELIMITERS = [",", ";", "\t", "|"] as const;
const DELIMITER_KEYS: Record<string, string> = {
  ",": "comma",
  ";": "semicolon",
  "\t": "tab",
  "|": "pipe",
};
const ENCODINGS = ["UTF-8", "windows-1252", "ISO-8859-1", "UTF-16LE", "UTF-16BE"];

const LOSSY_KEYS = new Set([
  "merges",
  "styles",
  "charts",
  "images",
  "macros",
  "conditionalFormatting",
  "dataValidations",
  "pivotTables",
  "comments",
  "numberFormats",
  "hiddenSheets",
  "definedNames",
  "frozenPanes",
  "tables",
]);

interface SheetPanelProps {
  sheets: { name: string; rows: number; cols: number }[];
  active: number;
  csv: CsvOptions | null;
  lossy: string[];
  readOnly: boolean;
  onSelect(index: number): void;
  onCsvChange(csv: CsvOptions): void;
}

export function SheetPanel(p: SheetPanelProps) {
  const { t } = useTranslation("sheet");
  const csv = p.csv;
  const delimiterLabel = (d: string) => {
    const key = DELIMITER_KEYS[d];
    return key ? t(`panel.delimiters.${key}`) : d;
  };
  const encodings =
    csv && !ENCODINGS.includes(csv.encoding) ? [csv.encoding, ...ENCODINGS] : ENCODINGS;
  const delimiters =
    csv && !DELIMITERS.includes(csv.delimiter as (typeof DELIMITERS)[number])
      ? [csv.delimiter, ...DELIMITERS]
      : DELIMITERS;

  return (
    <div>
      {p.lossy.length > 0 && (
        <div className={styles.banner} role="alert">
          <strong>{t("lossy.title")}</strong>
          <ul>
            {p.lossy.map((k) => (
              <li key={k}>{LOSSY_KEYS.has(k) ? t(`lossy.items.${k}`) : k}</li>
            ))}
          </ul>
        </div>
      )}
      <h3 className={styles.subtitle}>{t("panel.sheets")}</h3>
      <ul className={styles.sheetList}>
        {p.sheets.map((s, i) => (
          <li key={`${i}:${s.name}`}>
            <button
              type="button"
              className={`${styles.sheetItem} ${i === p.active ? styles.sheetItemActive : ""}`}
              aria-current={i === p.active}
              onClick={() => p.onSelect(i)}
            >
              <span>{s.name}</span>
              <span className={styles.sheetDims}>
                {t("panel.dims", { rows: s.rows, cols: s.cols })}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {csv && (
        <>
          <h3 className={styles.subtitle}>{t("panel.csv")}</h3>
          <label className={styles.panelRow}>
            <span>{t("panel.delimiter")}</span>
            <select
              className={styles.field}
              value={csv.delimiter}
              disabled={p.readOnly}
              onChange={(e) => p.onCsvChange({ ...csv, delimiter: e.target.value })}
            >
              {delimiters.map((d) => (
                <option key={d} value={d}>
                  {delimiterLabel(d)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.panelRow}>
            <span>{t("panel.encoding")}</span>
            <select
              className={styles.field}
              value={csv.encoding}
              disabled={p.readOnly}
              onChange={(e) => p.onCsvChange({ ...csv, encoding: e.target.value })}
            >
              {encodings.map((enc) => (
                <option key={enc} value={enc}>
                  {enc}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.panelRow}>
            <span>{t("panel.header")}</span>
            <span>{csv.header ? t("panel.yes") : t("panel.no")}</span>
          </div>
        </>
      )}
    </div>
  );
}
