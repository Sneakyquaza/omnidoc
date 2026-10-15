import { useMemo } from "react";
import type { MouseEvent, RefObject } from "react";
import { useTranslation } from "react-i18next";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { reportError } from "../../shell/errors";
import styles from "./TextEditor.module.css";

const md = new MarkdownIt({ html: false, linkify: true });

/** Rendu Markdown assaini : pas d'images (aucun accès réseau), pas de styles ni de formulaires. */
export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(md.render(source), {
    FORBID_TAGS: ["img", "style", "form", "input", "iframe", "script"],
    FORBID_ATTR: ["style"],
  });
}

interface Props {
  getText(): string;
  /** Change quand le texte a changé (rendu différé). */
  version: number;
  containerRef: RefObject<HTMLDivElement | null>;
}

export function MarkdownPreview({ getText, version, containerRef }: Props) {
  const { t } = useTranslation("text");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const html = useMemo(() => renderMarkdown(getText()), [getText, version]);

  function onClick(e: MouseEvent<HTMLDivElement>) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) openUrl(href).catch(reportError);
  }

  return (
    <div
      ref={containerRef}
      className={styles.preview}
      role="region"
      aria-label={t("preview.label")}
      tabIndex={0}
      onClick={onClick}
      onAuxClick={(e) => e.preventDefault()}
      // Contenu assaini par DOMPurify ci-dessus.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
