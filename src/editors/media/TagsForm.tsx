import { useTranslation } from "react-i18next";
import type { KeyValue } from "../../ipc/bindings";
import { Button } from "../../shell/ui/Button";
import { NORMALIZED_KEYS } from "./tags";
import type { NormalizedKey, TagFields } from "./tags";
import styles from "./MediaEditor.module.css";

const MULTILINE = new Set<NormalizedKey>(["comment", "lyrics"]);

interface TagsFormProps {
  fields: TagFields;
  extra: KeyValue[];
  readOnly: boolean;
  onField(key: NormalizedKey, value: string): void;
  onExtra(extra: KeyValue[]): void;
}

export function TagsForm({ fields, extra, readOnly, onField, onExtra }: TagsFormProps) {
  const { t } = useTranslation("media");

  return (
    <section className={styles.tags} aria-label={t("tags.title")}>
      <h2 className={styles.heading}>{t("tags.title")}</h2>
      {readOnly && <p className={styles.notice}>{t("tags.readOnly")}</p>}
      <div className={styles.fields}>
        {NORMALIZED_KEYS.map((key) => {
          const id = `media-tag-${key}`;
          return (
            <div key={key} className={MULTILINE.has(key) ? styles.fieldWide : styles.field}>
              <label htmlFor={id}>{t(`tags.fields.${key}`)}</label>
              {MULTILINE.has(key) ? (
                <textarea
                  id={id}
                  className={styles.input}
                  rows={key === "lyrics" ? 6 : 3}
                  value={fields[key]}
                  readOnly={readOnly}
                  onChange={(e) => onField(key, e.target.value)}
                />
              ) : (
                <input
                  id={id}
                  className={styles.input}
                  value={fields[key]}
                  readOnly={readOnly}
                  onChange={(e) => onField(key, e.target.value)}
                />
              )}
            </div>
          );
        })}
      </div>

      <h3 className={styles.subheading}>{t("tags.other")}</h3>
      {extra.length === 0 && <p className={styles.muted}>{t("tags.noOther")}</p>}
      <ul className={styles.extraList}>
        {extra.map((tag, i) => (
          <li key={i} className={styles.extraRow}>
            <input
              className={styles.input}
              aria-label={t("tags.key")}
              placeholder={t("tags.key")}
              value={tag.key}
              readOnly={readOnly}
              onChange={(e) =>
                onExtra(extra.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
              }
            />
            <input
              className={styles.input}
              aria-label={t("tags.value")}
              placeholder={t("tags.value")}
              value={tag.value}
              readOnly={readOnly}
              onChange={(e) =>
                onExtra(extra.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
              }
            />
            <Button
              variant="ghost"
              icon="close"
              disabled={readOnly}
              aria-label={t("tags.remove", { key: tag.key })}
              title={t("tags.remove", { key: tag.key })}
              onClick={() => onExtra(extra.filter((_, j) => j !== i))}
            />
          </li>
        ))}
      </ul>
      <Button
        icon="plus"
        disabled={readOnly}
        onClick={() => onExtra([...extra, { key: "", value: "" }])}
      >
        {t("tags.add")}
      </Button>
    </section>
  );
}
