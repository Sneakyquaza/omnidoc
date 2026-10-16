import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../../ipc/bindings";
import type { DocumentModel, Slide, SlidesDoc } from "../../ipc/bindings";
import { reportError } from "../../shell/errors";
import { basename } from "../../shell/paths";
import { EditorSidePanel, EditorToolbar } from "../../shell/slots";
import { Button } from "../../shell/ui/Button";
import { ToolBar, ToolGroup } from "../../shell/ui/ToolBar";
import { pushToast } from "../../shell/ui/toastStore";
import type { EditorProps } from "../types";
import { clampIndex, isSafeThumbnail, slideBullets, slideTitle } from "./logic";
import styles from "./SlidesEditor.module.css";

function SlideCard({ slide, large }: { slide: Slide; large?: boolean }) {
  const bullets = slideBullets(slide);
  return (
    <div className={`${styles.card} ${large ? styles.cardLarge : ""}`}>
      <div className={styles.cardTitle}>{slideTitle(slide)}</div>
      {bullets.length > 0 ? (
        <ul className={styles.bullets}>
          {bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function SlidesEditor({
  tab,
  model,
  registerCommands,
  setStatus,
}: EditorProps<SlidesDoc>) {
  const { t } = useTranslation("slides");
  const count = model.slides.length;
  const [index, setIndex] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const current = model.slides[index];

  const go = useCallback((i: number) => setIndex(clampIndex(i, count)), [count]);

  const present = useCallback(() => {
    if (count === 0) return;
    setPresenting(true);
    setTimeout(() => {
      overlayRef.current?.focus();
      overlayRef.current?.requestFullscreen?.().catch(() => undefined);
    }, 0);
  }, [count]);

  const stopPresenting = useCallback(() => {
    setPresenting(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, []);

  // Échap natif en plein écran : on referme aussi la surcouche.
  useEffect(() => {
    if (!presenting) return;
    const onChange = () => {
      if (!document.fullscreenElement) setPresenting(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [presenting]);

  const exportMd = useCallback(async () => {
    try {
      const dest = await saveDialog({
        defaultPath: `${(tab.path ? basename(tab.path) : tab.title).replace(/\.[^.]+$/, "")}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (dest === null) return;
      const doc: DocumentModel = { ...model, kind: "slides" };
      await commands.exportDocument(doc, tab.handlerId, "md", dest);
      pushToast({ kind: "success", text: t("export.done", { name: basename(dest) }) });
    } catch (e) {
      reportError(e);
    }
  }, [model, tab.handlerId, tab.path, tab.title, t]);

  useEffect(() => {
    registerCommands([
      { id: "slides.present", title: t("commands.present"), shortcut: "F5", run: present },
      { id: "slides.exportMd", title: t("commands.exportMd"), run: () => void exportMd() },
    ]);
  }, [registerCommands, t, present, exportMd]);

  useEffect(() => {
    setStatus([{ id: "slides.position", text: t("status.position", { n: index + 1, count }) }]);
  }, [setStatus, t, index, count]);

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") go(index + 1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") go(index - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(count - 1);
    else return;
    e.preventDefault();
  }

  function onPresentKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      stopPresenting();
    } else onKey(e);
  }

  return (
    <div className={styles.root}>
      <EditorToolbar>
        <ToolBar label={t("toolbar.label")}>
          <ToolGroup>
            <Button icon="slides" onClick={present} disabled={count === 0}>
              {t("present")}
            </Button>
            <Button icon="export" onClick={() => void exportMd()}>
              {t("export.md")}
            </Button>
          </ToolGroup>
        </ToolBar>
      </EditorToolbar>
      <EditorSidePanel title={t("thumbs.title")} side="left">
        {isSafeThumbnail(model.thumbnail) ? (
          <img className={styles.fileThumb} src={model.thumbnail} alt={t("thumbs.fileThumbnail")} />
        ) : null}
        <ul className={styles.thumbs}>
          {model.slides.map((s, i) => (
            <li key={i}>
              <button
                type="button"
                className={styles.thumbButton}
                aria-current={i === index}
                aria-label={t("thumbs.slide", { n: i + 1, title: slideTitle(s) })}
                onClick={() => go(i)}
              >
                <span className={styles.thumbNum}>{i + 1}</span>
                <span className={styles.thumb}>
                  <span className={styles.thumbText}>{slideTitle(s)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </EditorSidePanel>
      <div className={styles.banner} role="note">
        {t("textOnly")}
      </div>
      <div className={styles.stage} onKeyDown={onKey} tabIndex={0} aria-label={t("stage")}>
        {current ? (
          <>
            <SlideCard slide={current} large />
            <section className={styles.notes} aria-label={t("notes.label")}>
              <h3 className={styles.notesTitle}>{t("notes.label")}</h3>
              {current.notes ? (
                <p className={styles.notesText}>{current.notes}</p>
              ) : (
                <p className={styles.muted}>{t("notes.none")}</p>
              )}
            </section>
          </>
        ) : (
          <p className={styles.muted}>{t("empty")}</p>
        )}
      </div>
      {presenting && current ? (
        <div
          ref={overlayRef}
          className={styles.overlay}
          role="dialog"
          aria-modal="true"
          aria-label={t("presentation")}
          tabIndex={-1}
          onKeyDown={onPresentKey}
        >
          <SlideCard slide={current} large />
          <div className={styles.overlayHint}>
            {t("status.position", { n: index + 1, count })} — {t("exitHint")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
