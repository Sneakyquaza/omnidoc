import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DbColumn, DbColumnDef, DbInput } from "../../ipc/bindings";
import { Button } from "../../shell/ui/Button";
import {
  COLUMN_TYPES,
  defaultColumnDef,
  inputFor,
  validColumnDefs,
  validColumnType,
  validObjectName,
} from "./logic";
import styles from "./EditDialogs.module.css";

function Modal({
  title,
  onCancel,
  onSubmit,
  submitLabel,
  submitDisabled,
  children,
}: {
  title: string;
  onCancel(): void;
  onSubmit(): void;
  submitLabel: string;
  submitDisabled?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input, select, button")?.focus();
  }, []);
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!submitDisabled) onSubmit();
  }
  return (
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        ref={ref}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={submit}
        onKeyDown={onKeyDown}
      >
        <h2 className={styles.title}>{title}</h2>
        {children}
        <div className={styles.actions}>
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={submitDisabled}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Saisie d'un nom (renommer une table ou une colonne). */
export function NameDialog({
  title,
  label,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  onSubmit(name: string): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(initial);
  const ok = validObjectName(name) && name !== initial;
  return (
    <Modal
      title={title}
      onCancel={onCancel}
      onSubmit={() => onSubmit(name)}
      submitLabel={submitLabel}
      submitDisabled={!ok}
    >
      <label className={styles.field}>
        {label}
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="db-dialog-name"
        />
      </label>
    </Modal>
  );
}

const OTHER = "__other__";

/** Liste de types usuels + saisie libre. */
function TypeField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange(v: string): void;
  label: string;
}) {
  const { t } = useTranslation("database");
  const known = (COLUMN_TYPES as readonly string[]).includes(value);
  const [other, setOther] = useState(!known);
  return (
    <div className={styles.typeRow}>
      <select
        className={styles.input}
        aria-label={label}
        value={other ? OTHER : value}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setOther(true);
            onChange("");
          } else {
            setOther(false);
            onChange(e.target.value);
          }
        }}
      >
        {COLUMN_TYPES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
        <option value={OTHER}>{t("column.typeOther")}</option>
      </select>
      {other ? (
        <input
          className={styles.input}
          aria-label={t("column.typeFree")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
    </div>
  );
}

export interface NewColumn {
  name: string;
  colType: string;
  notNull: boolean;
  default: string | null;
}

export function AddColumnDialog({
  onSubmit,
  onCancel,
}: {
  onSubmit(col: NewColumn): void;
  onCancel(): void;
}) {
  const { t } = useTranslation("database");
  const [name, setName] = useState("");
  const [colType, setColType] = useState("TEXT");
  const [notNull, setNotNull] = useState(false);
  const [def, setDef] = useState("");
  const ok = validObjectName(name) && validColumnType(colType);
  return (
    <Modal
      title={t("column.addTitle")}
      onCancel={onCancel}
      onSubmit={() => onSubmit({ name, colType, notNull, default: def === "" ? null : def })}
      submitLabel={t("column.add")}
      submitDisabled={!ok}
    >
      <label className={styles.field}>
        {t("column.name")}
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="db-dialog-name"
        />
      </label>
      <div className={styles.field}>
        {t("column.type")}
        <TypeField value={colType} onChange={setColType} label={t("column.type")} />
      </div>
      <label className={`${styles.field} ${styles.inline}`}>
        <input type="checkbox" checked={notNull} onChange={(e) => setNotNull(e.target.checked)} />
        {t("column.notNull")}
      </label>
      <label className={styles.field}>
        {t("column.default")}
        <input className={styles.input} value={def} onChange={(e) => setDef(e.target.value)} />
      </label>
      {notNull && def === "" ? <p className={styles.hint}>{t("column.notNullHint")}</p> : null}
    </Modal>
  );
}

export function NewTableDialog({
  onSubmit,
  onCancel,
}: {
  onSubmit(name: string, columns: DbColumnDef[]): void;
  onCancel(): void;
}) {
  const { t } = useTranslation("database");
  const [name, setName] = useState("");
  const [cols, setCols] = useState<DbColumnDef[]>(() => [defaultColumnDef()]);
  const patch = (i: number, p: Partial<DbColumnDef>) =>
    setCols((c) => c.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const ok =
    validObjectName(name) &&
    validColumnDefs(cols) &&
    cols.every((c) => validObjectName(c.name) && validColumnType(c.colType));
  return (
    <Modal
      title={t("table.newTitle")}
      onCancel={onCancel}
      onSubmit={() => onSubmit(name, cols)}
      submitLabel={t("table.create")}
      submitDisabled={!ok}
    >
      <label className={styles.field}>
        {t("table.name")}
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="db-dialog-name"
        />
      </label>
      <div className={styles.field}>
        {t("table.columns")}
        {cols.map((c, i) => (
          <div key={i} className={styles.colRow}>
            <input
              className={styles.input}
              aria-label={t("column.name")}
              value={c.name}
              onChange={(e) => patch(i, { name: e.target.value })}
            />
            <TypeField
              value={c.colType}
              onChange={(v) => patch(i, { colType: v })}
              label={t("column.type")}
            />
            <label className={`${styles.field} ${styles.inline}`}>
              <input
                type="checkbox"
                checked={c.primaryKey}
                onChange={(e) => patch(i, { primaryKey: e.target.checked })}
              />
              {t("table.primaryKey")}
            </label>
            <label className={`${styles.field} ${styles.inline}`}>
              <input
                type="checkbox"
                checked={c.notNull}
                onChange={(e) => patch(i, { notNull: e.target.checked })}
              />
              {t("column.notNull")}
            </label>
            <Button
              aria-label={t("table.removeColumn")}
              title={t("table.removeColumn")}
              icon="close"
              disabled={cols.length === 1}
              onClick={() => setCols((l) => l.filter((_, j) => j !== i))}
            />
          </div>
        ))}
        <div>
          <Button
            icon="plus"
            onClick={() =>
              setCols((l) => [
                ...l,
                { name: "", colType: "TEXT", primaryKey: false, notNull: false },
              ])
            }
          >
            {t("table.addColumn")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Formulaire d'insertion : champ vide = valeur par défaut de la colonne. */
export function InsertRowDialog({
  columns,
  onSubmit,
  onCancel,
}: {
  columns: DbColumn[];
  onSubmit(values: [string, DbInput][]): void;
  onCancel(): void;
}) {
  const { t } = useTranslation("database");
  const [texts, setTexts] = useState<string[]>(() => columns.map(() => ""));
  const [nulls, setNulls] = useState<boolean[]>(() => columns.map(() => false));
  function submit() {
    const values: [string, DbInput][] = [];
    columns.forEach((c, i) => {
      if (nulls[i]) values.push([c.name, { type: "null" }]);
      else if (texts[i] !== "") values.push([c.name, inputFor(texts[i] ?? "", c.type)]);
    });
    onSubmit(values);
  }
  return (
    <Modal
      title={t("rows.insertTitle")}
      onCancel={onCancel}
      onSubmit={submit}
      submitLabel={t("rows.insert")}
    >
      <p className={styles.hint}>{t("rows.insertHint")}</p>
      {columns.map((c, i) => (
        <div key={c.name} className={styles.valueRow}>
          <span className={styles.valueLabel} title={`${c.name} ${c.type}`}>
            {c.name} <span className={styles.hint}>{c.type}</span>
          </span>
          <input
            className={styles.input}
            aria-label={c.name}
            value={texts[i]}
            disabled={nulls[i]}
            onChange={(e) => setTexts((l) => l.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <label className={`${styles.field} ${styles.inline}`}>
            <input
              type="checkbox"
              checked={nulls[i]}
              onChange={(e) => setNulls((l) => l.map((x, j) => (j === i ? e.target.checked : x)))}
            />
            NULL
          </label>
        </div>
      ))}
    </Modal>
  );
}
