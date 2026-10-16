import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import type { NotebookCell } from "../../ipc/bindings";

// Aucune ressource externe : seules les images « data:image/ » sont conservées.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  for (const attr of ["src", "srcset", "poster", "background"]) {
    const value = node.getAttribute?.(attr);
    if (value !== null && value !== undefined && !isSafeImageUri(value)) {
      node.removeAttribute(attr);
    }
  }
  if (node.tagName === "A") {
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Assainit du HTML (sorties de cellule, rendu markdown) avant injection. */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"],
    FORBID_ATTR: ["style"],
  });
}

const md = new MarkdownIt({ html: false, linkify: true });

export function renderMarkdown(source: string): string {
  return sanitizeHtml(md.render(source));
}

export function isSafeImageUri(uri: string): boolean {
  return /^data:image\/(png|jpe?g|gif|webp|svg\+xml|bmp);/i.test(uri.trim());
}

export interface OutlineItem {
  /** Index de la cellule markdown. */
  cell: number;
  level: number;
  text: string;
}

/** Titres markdown (`#`…`######`) des cellules markdown, hors blocs de code. */
export function extractOutline(cells: NotebookCell[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  cells.forEach((c, cell) => {
    if (c.cellType !== "markdown") return;
    let fence: string | null = null;
    for (const line of c.source.split("\n")) {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (f?.[1]) {
        const marker = f[1].charAt(0);
        if (fence === null) fence = marker;
        else if (fence === marker) fence = null;
        continue;
      }
      if (fence !== null) continue;
      const h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h?.[1] && h[2]) items.push({ cell, level: h[1].length, text: h[2] });
    }
  });
  return items;
}
