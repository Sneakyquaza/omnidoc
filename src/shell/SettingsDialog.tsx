import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AUTOSAVE_CHOICES,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  useSettings,
} from "../stores/settings";
import type { Language, Theme } from "../stores/settings";
import { useRecent } from "../stores/recent";
import { useUi } from "../stores/ui";
import { useRuntime } from "./runtime";
import { useShellCommands } from "./commands";
import {
  applyShortcutOverrides,
  eventToShortcut,
  findShortcutConflicts,
  formatShortcut,
} from "./shortcuts";
import { Button } from "./ui/Button";
import styles from "./SettingsDialog.module.css";

export const REPOSITORY_URL = "https://github.com/Sneakyquaza/omnidoc";

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  return open ? <SettingsBody /> : null;
}

function SettingsBody() {
  const { t } = useTranslation("settings");
  const close = useUi((s) => s.setSettingsOpen);
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus?.();
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close(false);
    } else if (e.key === "Tab") {
      const items = Array.from(
        ref.current?.querySelectorAll<HTMLElement>("button, input, select") ?? [],
      ).filter((el) => !el.hasAttribute("disabled"));
      const first = items[0];
      const last = items[items.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === ref.current)
      ) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }

  return (
    <div className={styles.overlay}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          {t("title")}
        </h2>
        <div className={styles.content}>
          <AppearanceSection />
          <EditingSection />
          <ShortcutsSection />
          <FilesSection />
          <AboutSection />
        </div>
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => close(false)}>
            {t("close")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AppearanceSection() {
  const { t } = useTranslation("settings");
  const s = useSettings();
  const ids = { theme: useId(), language: useId(), scale: useId() };
  return (
    <section aria-labelledby={ids.theme + "-h"} className={styles.section}>
      <h3 id={ids.theme + "-h"}>{t("appearance.title")}</h3>
      <div className={styles.row}>
        <label htmlFor={ids.theme}>{t("appearance.theme")}</label>
        <select
          id={ids.theme}
          value={s.theme}
          onChange={(e) => s.setTheme(e.target.value as Theme)}
        >
          {(["system", "light", "dark"] as const).map((v) => (
            <option key={v} value={v}>
              {t(`appearance.themes.${v}`)}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.row}>
        <label htmlFor={ids.language}>{t("appearance.language")}</label>
        <select
          id={ids.language}
          data-testid="settings-language"
          value={s.language}
          onChange={(e) => s.setLanguage(e.target.value as Language)}
        >
          <option value="auto">{t("appearance.languageAuto")}</option>
          <option value="fr">Français</option>
          <option value="en">English</option>
        </select>
      </div>
      <div className={styles.row}>
        <label htmlFor={ids.scale}>{t("appearance.uiScale", { value: s.uiScale })}</label>
        <input
          id={ids.scale}
          type="range"
          min={UI_SCALE_MIN}
          max={UI_SCALE_MAX}
          step={5}
          value={s.uiScale}
          onChange={(e) => s.setUiScale(Number(e.target.value))}
        />
      </div>
    </section>
  );
}

function EditingSection() {
  const { t } = useTranslation("settings");
  const s = useSettings();
  const ids = { autosave: useId(), family: useId(), size: useId(), confirm: useId() };
  return (
    <section aria-labelledby={ids.autosave + "-h"} className={styles.section}>
      <h3 id={ids.autosave + "-h"}>{t("editing.title")}</h3>
      <div className={styles.row}>
        <label htmlFor={ids.autosave}>{t("editing.autosave")}</label>
        <select
          id={ids.autosave}
          value={s.autosaveSeconds}
          onChange={(e) => s.setAutosaveSeconds(Number(e.target.value))}
        >
          {AUTOSAVE_CHOICES.map((v) => (
            <option key={v} value={v}>
              {v === 0 ? t("editing.autosaveOff") : t("editing.autosaveEvery", { count: v })}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.row}>
        <label htmlFor={ids.confirm}>{t("editing.confirmPartial")}</label>
        <input
          id={ids.confirm}
          type="checkbox"
          checked={s.confirmPartialSave}
          onChange={(e) => s.setConfirmPartialSave(e.target.checked)}
        />
      </div>
      <div className={styles.row}>
        <label htmlFor={ids.family}>{t("editing.fontFamily")}</label>
        <input
          id={ids.family}
          type="text"
          value={s.editorFontFamily}
          placeholder={t("editing.fontFamilyPlaceholder")}
          onChange={(e) => s.setEditorFontFamily(e.target.value)}
        />
      </div>
      <div className={styles.row}>
        <label htmlFor={ids.size}>{t("editing.fontSize")}</label>
        <input
          id={ids.size}
          type="number"
          min={EDITOR_FONT_SIZE_MIN}
          max={EDITOR_FONT_SIZE_MAX}
          value={s.editorFontSize}
          onChange={(e) => s.setEditorFontSize(Number(e.target.value))}
        />
      </div>
    </section>
  );
}

function ShortcutsSection() {
  const { t } = useTranslation("settings");
  const { all } = useShellCommands();
  const overrides = useSettings((s) => s.shortcuts);
  const editorsByTab = useRuntime((s) => s.commands);
  const setShortcut = useSettings((s) => s.setShortcut);
  const resetShortcut = useSettings((s) => s.resetShortcut);
  const resetShortcuts = useSettings((s) => s.resetShortcuts);
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ id: string; with: string } | null>(null);
  const titleId = useId();
  const items = all.filter((c) => !c.hidden);

  function onCapture(id: string, e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(null);
      setConflict(null);
      return;
    }
    const shortcut = eventToShortcut(e.nativeEvent);
    if (shortcut === null) return;
    // Aussi contre les raccourcis des éditeurs des autres onglets ouverts.
    const known = new Set(all.map((c) => c.id));
    const others = applyShortcutOverrides(
      Object.values(editorsByTab)
        .flat()
        .filter((c) => !known.has(c.id)),
      overrides,
    );
    const candidates = [...all, ...others];
    const clash = findShortcutConflicts(candidates, id, shortcut)[0];
    if (clash !== undefined) {
      const title = candidates.find((c) => c.id === clash)?.title ?? clash;
      setConflict({ id, with: title });
      return;
    }
    setConflict(null);
    setShortcut(id, shortcut);
    setRecording(null);
  }

  return (
    <section aria-labelledby={titleId} className={styles.section}>
      <h3 id={titleId}>{t("shortcuts.title")}</h3>
      <p className={styles.hint}>{t("shortcuts.hint")}</p>
      <ul className={styles.shortcuts}>
        {items.map((c) => {
          const isRecording = recording === c.id;
          const overridden = overrides[c.id] !== undefined;
          return (
            <li key={c.id} className={styles.shortcutRow}>
              <span className={styles.shortcutTitle}>{c.title}</span>
              <button
                type="button"
                className={styles.keys}
                aria-label={t("shortcuts.edit", { name: c.title })}
                onClick={() => {
                  setRecording(c.id);
                  setConflict(null);
                }}
                onKeyDown={isRecording ? (e) => onCapture(c.id, e) : undefined}
                onBlur={() => isRecording && setRecording(null)}
              >
                {isRecording
                  ? t("shortcuts.press")
                  : c.shortcut
                    ? formatShortcut(c.shortcut)
                    : t("shortcuts.none")}
              </button>
              <Button
                variant="ghost"
                disabled={!c.shortcut}
                aria-label={t("shortcuts.clear", { name: c.title })}
                onClick={() => setShortcut(c.id, "")}
              >
                {t("shortcuts.remove")}
              </Button>
              <Button
                variant="ghost"
                disabled={!overridden}
                aria-label={t("shortcuts.reset", { name: c.title })}
                onClick={() => resetShortcut(c.id)}
              >
                {t("shortcuts.resetOne")}
              </Button>
              {conflict?.id === c.id && (
                <span role="alert" className={styles.conflict}>
                  {t("shortcuts.conflict", { name: conflict.with })}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <Button onClick={resetShortcuts} disabled={Object.keys(overrides).length === 0}>
        {t("shortcuts.resetAll")}
      </Button>
    </section>
  );
}

function FilesSection() {
  const { t } = useTranslation("settings");
  const count = useRecent((s) => s.paths.length);
  const clear = useRecent((s) => s.clear);
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={styles.section}>
      <h3 id={titleId}>{t("files.title")}</h3>
      <div className={styles.row}>
        <span>{t("files.recent", { count })}</span>
        <Button disabled={count === 0} onClick={clear}>
          {t("files.clearRecent")}
        </Button>
      </div>
    </section>
  );
}

function AboutSection() {
  const { t } = useTranslation("settings");
  const [version, setVersion] = useState("");
  const titleId = useId();
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => undefined);
  }, []);
  return (
    <section aria-labelledby={titleId} className={styles.section}>
      <h3 id={titleId}>{t("about.title")}</h3>
      <p>
        {t("app.title", { ns: "common" })} {version && t("about.version", { version })}
      </p>
      <p>{t("about.license")}</p>
      <div className={styles.row}>
        <span className={styles.repo}>{REPOSITORY_URL}</span>
        <Button onClick={() => void openUrl(REPOSITORY_URL).catch(() => undefined)}>
          {t("about.openRepo")}
        </Button>
      </div>
    </section>
  );
}
