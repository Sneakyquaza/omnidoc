import type { EbookChapter } from "../../ipc/bindings";

export type ReaderTheme = "auto" | "light" | "sepia" | "dark";
export type ReaderFont = "serif" | "sans";

export interface ReaderSettings {
  font: ReaderFont;
  /** Taille de police en px. */
  size: number;
  lineHeight: number;
  /** Largeur de colonne en px. */
  width: number;
  theme: ReaderTheme;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  font: "serif",
  size: 18,
  lineHeight: 1.6,
  width: 680,
  theme: "auto",
};

export const MIN_SIZE = 12;
export const MAX_SIZE = 32;

export interface Palette {
  bg: string;
  text: string;
  link: string;
  muted: string;
}

export const PALETTES: Record<Exclude<ReaderTheme, "auto">, Palette> = {
  light: { bg: "#ffffff", text: "#1b1f24", link: "#2563eb", muted: "#5b6470" },
  sepia: { bg: "#f4ecd8", text: "#4a3b28", link: "#8a4b0f", muted: "#7a6a54" },
  dark: { bg: "#14171c", text: "#e6e9ee", link: "#8db1ff", muted: "#98a1ad" },
};

export function clampSize(size: number): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size)));
}

/** Cible d'un lien interne `#chapter-<i>` ou `#chapter-<i>--<id>` (chapitre 0-based). */
export function parseAnchor(href: string): { chapter: number; id: string | null } | null {
  const m = /^#(chapter-(\d+)(?:--.*)?)$/.exec(href);
  if (!m?.[1] || !m[2]) return null;
  const hasId = m[1].includes("--");
  return { chapter: Number(m[2]), id: hasId ? m[1] : null };
}

export function chapterAnchor(chapter: number): string {
  return `chapter-${chapter}`;
}

/** Feuille de style liseuse injectée dans l'iframe. */
export function readerCss(s: ReaderSettings, p: Palette): string {
  const family =
    s.font === "serif"
      ? 'Georgia, "Iowan Old Style", "Times New Roman", serif'
      : 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  return `
html { background: ${p.bg}; color: ${p.text}; }
body { margin: 0; padding: 24px 16px 64px; font-family: ${family}; font-size: ${s.size}px; line-height: ${s.lineHeight}; }
main { max-width: ${s.width}px; margin: 0 auto; overflow-wrap: break-word; }
a { color: ${p.link}; }
img, svg, video { max-width: 100%; height: auto; }
h1, h2, h3, h4 { line-height: 1.25; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid ${p.muted}; color: ${p.muted}; }
pre, code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.9em; white-space: pre-wrap; }
table { border-collapse: collapse; }
td, th { border: 1px solid ${p.muted}; padding: 4px 8px; }
`;
}

/** Document complet de l'iframe (CSP restrictive : aucun script, aucune ressource distante). */
export function buildSrcdoc(html: string, s: ReaderSettings, p: Palette): string {
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${readerCss(s, p)}</style></head><body><main>${html}</main></body></html>`;
}

/** Progression globale (0–100) selon le chapitre courant et le défilement dans celui-ci. */
export function progressPercent(chapter: number, count: number, fraction: number): number {
  if (count <= 0) return 0;
  const f = Math.min(1, Math.max(0, fraction));
  return Math.round(((chapter + f) / count) * 100);
}

export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

export interface SearchHit {
  chapter: number;
  snippet: string;
}

/** Recherche insensible à la casse ; une entrée par occurrence (limitée à `max`). */
export function searchChapters(chapters: EbookChapter[], query: string, max = 200): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const hits: SearchHit[] = [];
  for (let c = 0; c < chapters.length; c++) {
    const text = htmlToText(chapters[c]?.html ?? "");
    const lower = text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lower.indexOf(q, from);
      if (at < 0) break;
      const start = Math.max(0, at - 30);
      const end = Math.min(text.length, at + q.length + 50);
      hits.push({
        chapter: c,
        snippet: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
      });
      if (hits.length >= max) return hits;
      from = at + q.length;
    }
  }
  return hits;
}

export interface SavedPosition {
  chapter: number;
  fraction: number;
}

const POS_PREFIX = "omnidoc.ebook.pos:";
const SETTINGS_KEY = "omnidoc.ebook.settings";

export function loadPosition(key: string, chapterCount: number): SavedPosition | null {
  try {
    const raw = localStorage.getItem(POS_PREFIX + key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedPosition>;
    if (typeof v.chapter !== "number" || typeof v.fraction !== "number") return null;
    if (v.chapter < 0 || v.chapter >= chapterCount) return null;
    return { chapter: v.chapter, fraction: Math.min(1, Math.max(0, v.fraction)) };
  } catch {
    return null;
  }
}

export function savePosition(key: string, pos: SavedPosition): void {
  try {
    localStorage.setItem(POS_PREFIX + key, JSON.stringify(pos));
  } catch {
    // stockage indisponible : la position n'est simplement pas mémorisée
  }
}

export function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const v = JSON.parse(raw) as Partial<ReaderSettings>;
    return {
      font: v.font === "sans" ? "sans" : "serif",
      size: clampSize(typeof v.size === "number" ? v.size : DEFAULT_SETTINGS.size),
      lineHeight: typeof v.lineHeight === "number" ? v.lineHeight : DEFAULT_SETTINGS.lineHeight,
      width: typeof v.width === "number" ? v.width : DEFAULT_SETTINGS.width,
      theme: v.theme === "light" || v.theme === "sepia" || v.theme === "dark" ? v.theme : "auto",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: ReaderSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignoré
  }
}
