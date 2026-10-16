import { useId } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RecordComponent } from "../../ipc/bindings";
import { Button } from "../../shell/ui/Button";
import {
  addProp,
  formatParams,
  handledIndices,
  parseParams,
  removeProp,
  updateProp,
} from "./logic";
import styles from "./RecordsEditor.module.css";

export type Change = (fn: (c: RecordComponent) => RecordComponent) => void;

interface FieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  readOnly?: boolean;
  multiline?: boolean;
  type?: string;
  placeholder?: string;
  list?: string;
  testId?: string;
}

export function Field({
  label,
  value,
  onChange,
  readOnly,
  multiline,
  type,
  placeholder,
  list,
  testId,
}: FieldProps) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          className={styles.input}
          rows={4}
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className={styles.input}
          type={type ?? "text"}
          value={value}
          readOnly={readOnly}
          placeholder={placeholder}
          list={list}
          data-testid={testId}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

export function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Propriétés non prises en charge par le formulaire : édition brute (nom, paramètres, valeur). */
export function AdvancedProps({
  comp,
  single,
  multi,
  onChange,
  readOnly,
}: {
  comp: RecordComponent;
  single: string[];
  multi: string[];
  onChange: Change;
  readOnly: boolean;
}) {
  const { t } = useTranslation("records");
  const handled = handledIndices(comp, single, multi);
  const rows = comp.props.map((p, i) => ({ p, i })).filter(({ i }) => !handled.has(i));
  return (
    <Section
      title={t("advanced.title")}
      actions={
        <Button
          icon="plus"
          disabled={readOnly}
          onClick={() => onChange((c) => addProp(c, { name: "X-", params: [], value: "" }))}
        >
          {t("advanced.add")}
        </Button>
      }
    >
      <p className={styles.hint}>{t("advanced.hint")}</p>
      {comp.children.length > 0 ? (
        <p className={styles.hint}>{t("advanced.children", { count: comp.children.length })}</p>
      ) : null}
      {rows.length === 0 ? <p className={styles.hint}>{t("advanced.empty")}</p> : null}
      {rows.map(({ p, i }) => (
        <div key={i} className={styles.advRow}>
          <input
            className={styles.input}
            aria-label={t("advanced.name")}
            value={p.name}
            readOnly={readOnly}
            onChange={(e) =>
              onChange((c) => updateProp(c, i, (q) => ({ ...q, name: e.target.value })))
            }
          />
          <input
            className={styles.input}
            aria-label={t("advanced.params")}
            placeholder={t("advanced.params")}
            value={formatParams(p.params)}
            readOnly={readOnly}
            onChange={(e) =>
              onChange((c) =>
                updateProp(c, i, (q) => ({ ...q, params: parseParams(e.target.value) })),
              )
            }
          />
          <input
            className={`${styles.input} ${styles.advValue}`}
            aria-label={t("advanced.value")}
            value={p.value}
            readOnly={readOnly}
            onChange={(e) =>
              onChange((c) => updateProp(c, i, (q) => ({ ...q, value: e.target.value })))
            }
          />
          <Button
            variant="ghost"
            aria-label={t("advanced.remove")}
            title={t("advanced.remove")}
            disabled={readOnly}
            onClick={() => onChange((c) => removeProp(c, i))}
          >
            ×
          </Button>
        </div>
      ))}
    </Section>
  );
}
