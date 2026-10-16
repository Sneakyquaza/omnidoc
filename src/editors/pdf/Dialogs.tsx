import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { PageRange } from "../../ipc/bindings";
import { basename } from "../../shell/paths";
import { Button } from "../../shell/ui/Button";
import { parsePageRanges } from "./ranges";
import styles from "./Dialogs.module.css";

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
    ref.current?.querySelector<HTMLElement>("input, textarea, button")?.focus();
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

export function TextPromptDialog({
  title,
  label,
  submitLabel,
  multiline,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  submitLabel: string;
  multiline?: boolean;
  onSubmit(text: string): void;
  onCancel(): void;
}) {
  const [text, setText] = useState("");
  return (
    <Modal
      title={title}
      onCancel={onCancel}
      onSubmit={() => onSubmit(text)}
      submitLabel={submitLabel}
      submitDisabled={text.trim() === ""}
    >
      <label className={styles.field}>
        <span>{label}</span>
        {multiline ? (
          <textarea
            className={styles.input}
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <input className={styles.input} value={text} onChange={(e) => setText(e.target.value)} />
        )}
      </label>
    </Modal>
  );
}

export function RangesDialog({
  pageCount,
  onSubmit,
  onCancel,
}: {
  pageCount: number;
  onSubmit(ranges: PageRange[]): void;
  onCancel(): void;
}) {
  const { t } = useTranslation("pdf");
  const [text, setText] = useState(`1-${pageCount}`);
  const result = parsePageRanges(text, pageCount);
  return (
    <Modal
      title={t("split.title")}
      onCancel={onCancel}
      onSubmit={() => result.ok && onSubmit(result.ranges)}
      submitLabel={t("split.choose")}
      submitDisabled={!result.ok}
    >
      <label className={styles.field}>
        <span>{t("split.label", { count: pageCount })}</span>
        <input
          className={styles.input}
          value={text}
          placeholder="1-3, 4-10"
          aria-invalid={!result.ok}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {!result.ok && (
        <p className={styles.error} role="alert">
          {t(`split.error.${result.error}`, { max: pageCount })}
        </p>
      )}
    </Modal>
  );
}

export interface MergeChoice {
  /** Fichiers dans l'ordre final (le document courant y figure). */
  paths: string[];
  /** `true` : le résultat remplace le document courant (placé en tête). */
  append: boolean;
}

export function MergeDialog({
  current,
  onSubmit,
  onCancel,
}: {
  current: string;
  onSubmit(choice: MergeChoice): void;
  onCancel(): void;
}) {
  const { t } = useTranslation("pdf");
  const [paths, setPaths] = useState<string[]>([current]);
  const [append, setAppend] = useState(false);

  async function add() {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!picked) return;
    setPaths((p) => [...p, ...(Array.isArray(picked) ? picked : [picked])]);
  }

  function move(i: number, d: number) {
    setPaths((p) => {
      const j = i + d;
      if (j < 0 || j >= p.length) return p;
      const next = p.slice();
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  const currentIdx = paths.indexOf(current);
  const ordered = append ? [current, ...paths.filter((_, i) => i !== currentIdx)] : paths;
  return (
    <Modal
      title={t("merge.title")}
      onCancel={onCancel}
      onSubmit={() => onSubmit({ paths: ordered, append })}
      submitLabel={t("merge.submit")}
      submitDisabled={paths.length < 2}
    >
      <ol className={styles.files} aria-label={t("merge.files")}>
        {paths.map((p, i) => (
          <li key={`${p}-${i}`} className={styles.file}>
            <span className={styles.fileName} title={p}>
              {basename(p)}
              {i === currentIdx ? ` ${t("merge.currentTag")}` : ""}
            </span>
            <Button
              variant="ghost"
              disabled={append || i === 0}
              onClick={() => move(i, -1)}
              aria-label={t("merge.up")}
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              disabled={append || i === paths.length - 1}
              onClick={() => move(i, 1)}
              aria-label={t("merge.down")}
            >
              ↓
            </Button>
            <Button
              variant="ghost"
              disabled={i === currentIdx}
              onClick={() => setPaths((l) => l.filter((_, k) => k !== i))}
              aria-label={t("merge.remove")}
            >
              ×
            </Button>
          </li>
        ))}
      </ol>
      <Button onClick={() => void add()}>{t("merge.add")}</Button>
      <label className={styles.check}>
        <input type="checkbox" checked={append} onChange={(e) => setAppend(e.target.checked)} />
        <span>{t("merge.append")}</span>
      </label>
    </Modal>
  );
}
