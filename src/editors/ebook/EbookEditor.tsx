import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { EbookDoc } from "../../ipc/bindings";
import { reportError } from "../../shell/errors";
import { EditorSidePanel, EditorToolbar } from "../../shell/slots";
import { Button, IconButton } from "../../shell/ui/Button";
import { ToolBar, ToolGroup } from "../../shell/ui/ToolBar";
import { confirm } from "../../shell/ui/dialogStore";
import type { EditorProps } from "../types";
import {
  MAX_SIZE,
  MIN_SIZE,
  PALETTES,
  buildSrcdoc,
  clampSize,
  loadPosition,
  loadSettings,
  parseAnchor,
  progressPercent,
  savePosition,
  saveSettings,
  searchChapters,
} from "./logic";
import type { Palette, ReaderFont, ReaderSettings, ReaderTheme } from "./logic";
import styles from "./EbookEditor.module.css";

/** Palette « auto » : reprend les variables de thème de l'application. */
function autoPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: get("--color-bg", PALETTES.light.bg),
    text: get("--color-text", PALETTES.light.text),
    link: get("--color-accent", PALETTES.light.link),
    muted: get("--color-text-muted", PALETTES.light.muted),
  };
}

interface Pending {
  fraction?: number;
  id?: string;
  find?: string;
}

export default function EbookEditor({
  tab,
  model,
  registerCommands,
  setStatus,
}: EditorProps<EbookDoc>) {
  const { t } = useTranslation("ebook");
  const count = model.chapters.length;
  const storageKey = tab.path ?? tab.id;

  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [position] = useState(() => loadPosition(storageKey, count));
  const [chapter, setChapter] = useState(position?.chapter ?? 0);
  const [fraction, setFraction] = useState(position?.fraction ?? 0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pending = useRef<Pending>({ fraction: position?.fraction ?? 0 });
  const chapterRef = useRef(chapter);
  const countRef = useRef(count);

  // Thème « auto » : se re-rend quand l'application change de thème (attribut data-theme).
  const [, setThemeTick] = useState(0);
  const fractionRef = useRef(fraction);
  useEffect(() => {
    fractionRef.current = fraction;
  }, [fraction]);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      pending.current = { fraction: fractionRef.current };
      setThemeTick((n) => n + 1);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  const palette = settings.theme === "auto" ? autoPalette() : PALETTES[settings.theme];
  const html = model.chapters[chapter]?.html ?? "";
  const srcDoc = useMemo(
    () => buildSrcdoc(html, settings, palette),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, settings, palette.bg, palette.text, palette.link, palette.muted],
  );
  const hits = useMemo(
    () => searchChapters(model.chapters, submitted),
    [model.chapters, submitted],
  );

  const goTo = useCallback((index: number, next: Pending = { fraction: 0 }) => {
    const clamped = Math.min(countRef.current - 1, Math.max(0, index));
    pending.current = next;
    if (clamped === chapterRef.current) {
      applyPending(iframeRef.current);
      return;
    }
    chapterRef.current = clamped;
    setChapter(clamped);
    setFraction(0);
  }, []);

  function applyPending(frame: HTMLIFrameElement | null) {
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (!doc || !win) return;
    const p = pending.current;
    if (p.id) {
      const el = doc.getElementById(p.id);
      if (el) el.scrollIntoView();
      else win.scrollTo(0, 0);
    } else if (p.fraction !== undefined) {
      const max = doc.documentElement.scrollHeight - win.innerHeight;
      win.scrollTo(0, max > 0 ? max * p.fraction : 0);
    }
    if (p.find) {
      try {
        (win as unknown as { find?: (q: string) => boolean }).find?.(p.find);
      } catch {
        // recherche native indisponible
      }
    }
    pending.current = {};
  }

  const handleKey = useCallback(
    (e: { key: string; preventDefault(): void }) => {
      const win = iframeRef.current?.contentWindow;
      const doc = iframeRef.current?.contentDocument;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        goTo(chapterRef.current + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goTo(chapterRef.current - 1, { fraction: 0 });
      } else if ((e.key === "PageDown" || e.key === "PageUp") && win && doc) {
        const max = doc.documentElement.scrollHeight - win.innerHeight;
        const down = e.key === "PageDown";
        if (down && win.scrollY >= max - 1 && chapterRef.current < countRef.current - 1) {
          e.preventDefault();
          goTo(chapterRef.current + 1);
        } else if (!down && win.scrollY <= 0 && chapterRef.current > 0) {
          e.preventDefault();
          goTo(chapterRef.current - 1, { fraction: 1 });
        } else {
          e.preventDefault();
          win.scrollBy(0, (down ? 1 : -1) * win.innerHeight * 0.9);
        }
      }
    },
    [goTo],
  );

  async function openExternal(url: string) {
    const ok = await confirm({
      title: t("external.title"),
      message: t("external.message", { url }),
      confirmLabel: t("external.open"),
    });
    if (!ok) return;
    try {
      await openUrl(url);
    } catch (e) {
      reportError(e);
    }
  }

  function onLoad() {
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (!frame || !doc || !win) return;
    applyPending(frame);
    doc.addEventListener("click", (e) => {
      const a = (e.target as Element | null)?.closest?.("a");
      const href = a?.getAttribute("href");
      if (!href) return;
      e.preventDefault();
      const target = parseAnchor(href);
      if (target) goTo(target.chapter, target.id ? { id: target.id } : { fraction: 0 });
      else if (/^(https?:|mailto:)/i.test(href)) void openExternal(href);
    });
    doc.addEventListener("keydown", (e) => handleKey(e));
    let frameRequest = 0;
    win.addEventListener("scroll", () => {
      cancelAnimationFrame(frameRequest);
      frameRequest = requestAnimationFrame(() => {
        const max = doc.documentElement.scrollHeight - win.innerHeight;
        setFraction(max > 0 ? Math.min(1, win.scrollY / max) : 0);
      });
    });
  }

  useEffect(() => {
    chapterRef.current = chapter;
    countRef.current = count;
  }, [chapter, count]);

  useEffect(() => {
    savePosition(storageKey, { chapter, fraction });
  }, [storageKey, chapter, fraction]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const percent = progressPercent(chapter, count, fraction);
  useEffect(() => {
    setStatus([
      { id: "ebook.chapter", text: t("status.chapter", { n: chapter + 1, count }) },
      { id: "ebook.progress", text: `${percent} %` },
    ]);
  }, [setStatus, t, chapter, count, percent]);

  useEffect(() => {
    registerCommands([
      {
        id: "ebook.search",
        title: t("commands.search"),
        shortcut: "Mod+F",
        run: () => {
          setSearchOpen(true);
          setTimeout(() => searchInputRef.current?.select(), 0);
        },
      },
      { id: "ebook.next", title: t("commands.next"), run: () => goTo(chapterRef.current + 1) },
      {
        id: "ebook.prev",
        title: t("commands.prev"),
        run: () => goTo(chapterRef.current - 1),
      },
    ]);
  }, [registerCommands, t, goTo]);

  function update(patch: Partial<ReaderSettings>) {
    pending.current = { fraction };
    setSettings((s) => ({ ...s, ...patch }));
  }

  function submitSearch(e: FormEvent) {
    e.preventDefault();
    setSubmitted(query);
  }

  function onRootKey(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("input, select, textarea")) return;
    handleKey(e);
  }

  const lossy = model.lossy ?? [];
  return (
    <div className={styles.root} onKeyDown={onRootKey}>
      <EditorToolbar>
        <ToolBar label={t("toolbar.label")}>
          <ToolGroup>
            <IconButton
              icon="chevronLeft"
              label={t("nav.prev")}
              disabled={chapter === 0}
              onClick={() => goTo(chapter - 1)}
            />
            <IconButton
              icon="chevronRight"
              label={t("nav.next")}
              disabled={chapter >= count - 1}
              onClick={() => goTo(chapter + 1)}
            />
          </ToolGroup>
          <ToolGroup>
            <select
              className={styles.select}
              aria-label={t("settings.font")}
              value={settings.font}
              onChange={(e) => update({ font: e.target.value as ReaderFont })}
            >
              <option value="serif">{t("settings.serif")}</option>
              <option value="sans">{t("settings.sans")}</option>
            </select>
            <IconButton
              icon="zoomOut"
              label={t("settings.smaller")}
              disabled={settings.size <= MIN_SIZE}
              onClick={() => update({ size: clampSize(settings.size - 1) })}
            />
            <span aria-live="polite">{settings.size}</span>
            <IconButton
              icon="zoomIn"
              label={t("settings.larger")}
              disabled={settings.size >= MAX_SIZE}
              onClick={() => update({ size: clampSize(settings.size + 1) })}
            />
            <select
              className={styles.select}
              aria-label={t("settings.lineHeight")}
              value={settings.lineHeight}
              onChange={(e) => update({ lineHeight: Number(e.target.value) })}
            >
              {[1.3, 1.6, 1.9].map((v) => (
                <option key={v} value={v}>
                  {t("settings.lineHeightValue", { v })}
                </option>
              ))}
            </select>
            <select
              className={styles.select}
              aria-label={t("settings.width")}
              value={settings.width}
              onChange={(e) => update({ width: Number(e.target.value) })}
            >
              {[520, 680, 860].map((v) => (
                <option key={v} value={v}>
                  {t("settings.widthValue", { v })}
                </option>
              ))}
            </select>
            <select
              className={styles.select}
              aria-label={t("settings.theme")}
              value={settings.theme}
              onChange={(e) => update({ theme: e.target.value as ReaderTheme })}
            >
              {(["auto", "light", "sepia", "dark"] as const).map((v) => (
                <option key={v} value={v}>
                  {t(`settings.themes.${v}`)}
                </option>
              ))}
            </select>
          </ToolGroup>
          <ToolGroup>
            <Button
              icon="search"
              onClick={() => {
                setSearchOpen((o) => !o);
                setTimeout(() => searchInputRef.current?.select(), 0);
              }}
            >
              {t("search.button")}
            </Button>
          </ToolGroup>
        </ToolBar>
      </EditorToolbar>
      <EditorSidePanel title={t("toc.title")} side="left">
        {count === 0 ? <p className={styles.muted}>{t("toc.empty")}</p> : null}
        <ol className={styles.toc} data-testid="ebook-toc">
          {model.chapters.map((c, i) => (
            <li key={i}>
              <button
                type="button"
                className={styles.tocButton}
                aria-current={i === chapter}
                onClick={() => goTo(i)}
              >
                {c.title || t("toc.untitled", { n: i + 1 })}
              </button>
            </li>
          ))}
        </ol>
      </EditorSidePanel>
      {lossy.length > 0 ? (
        <div className={styles.banner} role="note">
          {t("lossy.intro")} {lossy.map((id) => t(`lossy.${id}`, { defaultValue: id })).join(" ")}
        </div>
      ) : null}
      {searchOpen ? (
        <div className={styles.search}>
          <form className={styles.searchForm} onSubmit={submitSearch} role="search">
            <input
              ref={searchInputRef}
              className={styles.input}
              type="search"
              value={query}
              placeholder={t("search.placeholder")}
              aria-label={t("search.label")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearchOpen(false);
              }}
            />
            <Button type="submit" variant="primary">
              {t("search.go")}
            </Button>
            <span className={styles.muted} role="status">
              {submitted ? t("search.count", { count: hits.length }) : ""}
            </span>
          </form>
          {hits.length > 0 ? (
            <ul className={styles.hits} aria-label={t("search.results")}>
              {hits.map((h, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className={styles.hitButton}
                    onClick={() => goTo(h.chapter, { fraction: 0, find: submitted })}
                  >
                    <strong>{model.chapters[h.chapter]?.title || h.chapter + 1}</strong> {h.snippet}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {count === 0 ? (
        <p className={styles.muted}>{t("empty")}</p>
      ) : (
        <iframe
          ref={iframeRef}
          className={styles.frame}
          title={model.title || t("frame")}
          sandbox="allow-same-origin"
          srcDoc={srcDoc}
          onLoad={onLoad}
        />
      )}
    </div>
  );
}
