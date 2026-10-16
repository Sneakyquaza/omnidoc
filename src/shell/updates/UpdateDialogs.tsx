import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Update } from "@tauri-apps/plugin-updater";
import { renderMarkdown } from "../../editors/text/MarkdownPreview";
import { useSettings } from "../../stores/settings";
import { useTabs } from "../../stores/tabs";
import { Button } from "../ui/Button";
import { confirm } from "../ui/dialogStore";
import { answerConsent, RELEASES_URL, runStartupChecks, useUpdates } from "./store";
import styles from "./Updates.module.css";

/** Bandeau non bloquant : demande de consentement à la vérification automatique. */
export function ConsentBanner() {
  const { t } = useTranslation("updates");
  const pending = useUpdates((s) => s.consentPending);
  if (!pending) return null;
  return (
    <div className={styles.banner} role="region" aria-label={t("consent.label")}>
      <Download size={16} aria-hidden="true" />
      <span>{t("consent.message")}</span>
      <Button variant="primary" onClick={() => answerConsent(true)}>
        {t("consent.yes")}
      </Button>
      <Button onClick={() => answerConsent(false)}>{t("consent.no")}</Button>
    </div>
  );
}

let started = false;

export function UpdateDialogs() {
  useEffect(() => {
    if (started) return;
    started = true;
    void runStartupChecks();
  }, []);
  const update = useUpdates((s) => s.update);
  const notes = useUpdates((s) => s.notes);
  return (
    <>
      {update && <UpdateBody update={update} />}
      {!update && notes && <NotesBody />}
    </>
  );
}

function useModal(onEscape: () => void, blocked: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus?.();
  }, []);
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!blocked) onEscape();
    } else if (e.key === "Tab") {
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("button") ?? []).filter(
        (el) => !el.hasAttribute("disabled"),
      );
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
  return { ref, onKeyDown };
}

/** Notes Markdown assainies ; les liens s'ouvrent dans le navigateur. */
function Notes({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderMarkdown(markdown), [markdown]);
  function onClick(e: MouseEvent<HTMLDivElement>) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) void openUrl(href).catch(() => undefined);
  }
  return (
    <div
      className={styles.notes}
      data-testid="release-notes"
      tabIndex={0}
      onClick={onClick}
      // Contenu assaini par DOMPurify (renderMarkdown).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

type Phase = "idle" | "downloading" | "installing" | "error";

function UpdateBody({ update }: { update: Update }) {
  const { t, i18n } = useTranslation("updates");
  const setUpdate = useUpdates((s) => s.setUpdate);
  const current = useUpdates((s) => s.currentVersion);
  const setIgnored = useSettings((s) => s.setIgnoredUpdateVersion);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<{ done: number; total: number | null }>({
    done: 0,
    total: null,
  });
  const [error, setError] = useState("");
  const titleId = useId();
  const busy = phase === "downloading" || phase === "installing";
  const { ref, onKeyDown } = useModal(() => setUpdate(null), busy);

  const date = useMemo(() => {
    if (!update.date) return null;
    const d = new Date(update.date);
    return Number.isNaN(d.getTime())
      ? null
      : new Intl.DateTimeFormat(i18n.language, { dateStyle: "long" }).format(d);
  }, [update.date, i18n.language]);

  async function install() {
    const dirty = useTabs.getState().tabs.filter((x) => x.dirty).length;
    if (dirty > 0) {
      const ok = await confirm({
        title: t("dirty.title"),
        message: t("dirty.message", { count: dirty }),
        confirmLabel: t("dirty.continue"),
        danger: true,
      });
      if (!ok) return;
    }
    setPhase("downloading");
    setProgress({ done: 0, total: null });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setProgress({ done: 0, total: event.data.contentLength ?? null });
        } else if (event.event === "Progress") {
          setProgress((p) => ({ ...p, done: p.done + event.data.chunkLength }));
        } else {
          setPhase("installing");
        }
      });
      setPhase("installing");
      await relaunch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  const percent =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null;

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
        data-testid="update-dialog"
      >
        <h2 id={titleId} className={styles.title}>
          {t("dialog.title")}
        </h2>
        <p className={styles.versions}>
          {t("dialog.versions", { current: current || "?", next: update.version })}
          {date && <span className={styles.date}>{t("dialog.date", { date })}</span>}
        </p>
        <h3 className={styles.heading}>{t("dialog.notes")}</h3>
        {update.body ? <Notes markdown={update.body} /> : <p>{t("dialog.noNotes")}</p>}
        {busy && (
          <div className={styles.progress}>
            <progress max={100} value={percent ?? undefined} aria-label={t("progress.label")} />
            <span>
              {phase === "installing"
                ? t("progress.installing")
                : percent === null
                  ? t("progress.downloadingUnknown")
                  : t("progress.downloading", { percent })}
            </span>
          </div>
        )}
        {phase === "error" && (
          <p role="alert" className={styles.error}>
            {t("error.install", { message: error })}
          </p>
        )}
        <div className={styles.actions}>
          {phase === "error" && (
            <Button onClick={() => void openUrl(RELEASES_URL).catch(() => undefined)}>
              {t("dialog.openDownloadPage")}
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setIgnored(update.version);
              setUpdate(null);
            }}
          >
            {t("dialog.ignore")}
          </Button>
          <Button disabled={busy} onClick={() => setUpdate(null)}>
            {t("dialog.later")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void install()}>
            {phase === "error" ? t("dialog.retry") : t("dialog.install")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Nouveautés après mise à jour, ou CHANGELOG complet. */
function NotesBody() {
  const { t } = useTranslation("updates");
  const notes = useUpdates((s) => s.notes);
  const setNotes = useUpdates((s) => s.setNotes);
  const titleId = useId();
  const { ref, onKeyDown } = useModal(() => setNotes(null), false);
  if (!notes) return null;
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
        data-testid="release-notes-dialog"
      >
        <h2 id={titleId} className={styles.title}>
          {t(`notes.${notes.titleKey}`, { version: notes.version })}
        </h2>
        <Notes markdown={notes.markdown} />
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => setNotes(null)}>
            {t("notes.close")}
          </Button>
        </div>
      </div>
    </div>
  );
}
