import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../shell/ui/Button";
import { percentSize, proportionalSize } from "./geometry";
import { NEUTRAL_ADJUST } from "./ops";
import type { AdjustParams } from "./ops";
import styles from "./Dialogs.module.css";

interface ModalProps {
  title: string;
  children: ReactNode;
  onCancel(): void;
  onSubmit(): void;
  submitLabel: string;
  submitDisabled?: boolean;
}

function Modal({ title, children, onCancel, onSubmit, submitLabel, submitDisabled }: ModalProps) {
  const { t } = useTranslation("common");
  const titleId = useId();
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input, select")?.focus();
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!submitDisabled) onSubmit();
  }

  return (
    <div className={styles.overlay}>
      <form
        ref={ref}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <div className={styles.body}>{children}</div>
        <div className={styles.actions}>
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={submitDisabled}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}

function toInt(s: string): number {
  const n = Math.round(Number(s));
  return Number.isFinite(n) ? n : 0;
}

export function ResizeDialog({
  width,
  height,
  onCancel,
  onApply,
}: {
  width: number;
  height: number;
  onCancel(): void;
  onApply(width: number, height: number): void;
}) {
  const { t } = useTranslation("image");
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));
  const [keep, setKeep] = useState(true);
  const [pct, setPct] = useState("100");
  const wn = toInt(w);
  const hn = toInt(h);
  const valid = wn >= 1 && hn >= 1 && wn <= 32768 && hn <= 32768;

  function changeW(v: string) {
    setW(v);
    if (keep && toInt(v) >= 1) {
      const s = proportionalSize("width", toInt(v), width, height);
      setH(String(s.height));
      setPct(String(Math.round((s.width / width) * 1000) / 10));
    }
  }
  function changeH(v: string) {
    setH(v);
    if (keep && toInt(v) >= 1) {
      const s = proportionalSize("height", toInt(v), width, height);
      setW(String(s.width));
      setPct(String(Math.round((s.width / width) * 1000) / 10));
    }
  }
  function changePct(v: string) {
    setPct(v);
    const n = Number(v);
    if (n > 0) {
      const s = percentSize(n, width, height);
      setW(String(s.width));
      setH(String(s.height));
    }
  }

  return (
    <Modal
      title={t("resize.title")}
      onCancel={onCancel}
      onSubmit={() => onApply(wn, hn)}
      submitLabel={t("resize.apply")}
      submitDisabled={!valid}
    >
      <label className={styles.field}>
        <span>{t("resize.width")}</span>
        <input
          type="number"
          min={1}
          max={32768}
          value={w}
          onChange={(e) => changeW(e.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span>{t("resize.height")}</span>
        <input
          type="number"
          min={1}
          max={32768}
          value={h}
          onChange={(e) => changeH(e.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span>{t("resize.percent")}</span>
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={pct}
          onChange={(e) => changePct(e.target.value)}
        />
      </label>
      <label className={styles.check}>
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        <span>{t("resize.keepRatio")}</span>
      </label>
      {!valid && <p className={styles.error}>{t("resize.invalid")}</p>}
    </Modal>
  );
}

export function AdjustDialog({
  onChange,
  onCancel,
  onApply,
}: {
  /** Aperçu en direct. */
  onChange(p: AdjustParams): void;
  onCancel(): void;
  onApply(p: AdjustParams): void;
}) {
  const { t } = useTranslation("image");
  const [p, setP] = useState<AdjustParams>(NEUTRAL_ADJUST);

  function update(next: AdjustParams) {
    setP(next);
    onChange(next);
  }

  const slider = (key: "brightness" | "contrast" | "saturation") => (
    <label className={styles.field}>
      <span>
        {t(`adjust.${key}`)} ({p[key]})
      </span>
      <input
        type="range"
        min={-100}
        max={100}
        value={p[key]}
        onChange={(e) => update({ ...p, [key]: Number(e.target.value) })}
      />
    </label>
  );

  return (
    <Modal
      title={t("adjust.title")}
      onCancel={onCancel}
      onSubmit={() => onApply(p)}
      submitLabel={t("adjust.apply")}
    >
      {slider("brightness")}
      {slider("contrast")}
      {slider("saturation")}
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={p.grayscale}
          onChange={(e) => update({ ...p, grayscale: e.target.checked })}
        />
        <span>{t("adjust.grayscale")}</span>
      </label>
      <Button onClick={() => update(NEUTRAL_ADJUST)}>{t("adjust.reset")}</Button>
    </Modal>
  );
}

export function QualityDialog({
  format,
  onCancel,
  onApply,
}: {
  format: string;
  onCancel(): void;
  onApply(quality: number): void;
}) {
  const { t } = useTranslation("image");
  const [q, setQ] = useState(90);
  return (
    <Modal
      title={t("quality.title", { format: format.toUpperCase() })}
      onCancel={onCancel}
      onSubmit={() => onApply(q)}
      submitLabel={t("quality.apply")}
    >
      <label className={styles.field}>
        <span>{t("quality.label", { value: q })}</span>
        <input
          type="range"
          min={1}
          max={100}
          value={q}
          onChange={(e) => setQ(Number(e.target.value))}
        />
      </label>
    </Modal>
  );
}

export function ScaleDialog({
  width,
  height,
  onCancel,
  onApply,
}: {
  width: number;
  height: number;
  onCancel(): void;
  onApply(scale: number): void;
}) {
  const { t } = useTranslation("image");
  const [scale, setScale] = useState(1);
  return (
    <Modal
      title={t("exportPng.title")}
      onCancel={onCancel}
      onSubmit={() => onApply(scale)}
      submitLabel={t("exportPng.apply")}
    >
      <label className={styles.field}>
        <span>{t("exportPng.scale")}</span>
        <select value={scale} onChange={(e) => setScale(Number(e.target.value))}>
          {[1, 2, 4].map((s) => (
            <option key={s} value={s}>
              {s}× ({Math.round(width * s)} × {Math.round(height * s)})
            </option>
          ))}
        </select>
      </label>
    </Modal>
  );
}
