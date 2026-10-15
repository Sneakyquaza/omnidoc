/** Logique pure : normalisation du JSON TipTap vers le schéma produit par Rust, tailles, comptes. */

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  marks?: JsonMark[];
  text?: string;
}

interface JsonMark {
  type: string;
  attrs?: Record<string, unknown>;
}

const NODE_ATTRS: Record<string, string[]> = {
  paragraph: ["textAlign"],
  heading: ["level", "textAlign"],
  orderedList: ["start"],
  taskItem: ["checked"],
  codeBlock: ["language"],
  image: ["src", "alt", "title", "width"],
  tableHeader: ["colspan", "rowspan"],
  tableCell: ["colspan", "rowspan"],
};

const MARK_ATTRS: Record<string, string[]> = {
  bold: [],
  italic: [],
  underline: [],
  strike: [],
  code: [],
  subscript: [],
  superscript: [],
  link: ["href"],
  textStyle: ["color", "fontFamily", "fontSize"],
  highlight: ["color"],
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickAttrs(
  type: string,
  raw: unknown,
  allowed: string[],
  isNode: boolean,
): Record<string, unknown> | undefined {
  const src = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const v = src[key];
    if (v === undefined || v === null || v === "") continue;
    if (key === "textAlign" && !["center", "right", "justify"].includes(String(v))) continue;
    if (key === "width") {
      const w = typeof v === "string" ? Number.parseInt(v, 10) : Number(v);
      if (!Number.isFinite(w) || w <= 0) continue;
      out[key] = Math.round(w);
      continue;
    }
    out[key] = v;
  }
  if (isNode && type === "orderedList") out["start"] ??= 1;
  if (isNode && type === "taskItem") out["checked"] ??= false;
  if (isNode && (type === "tableHeader" || type === "tableCell")) {
    out["colspan"] ??= 1;
    out["rowspan"] ??= 1;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeMark(mark: JsonMark): JsonMark | null {
  const allowed = MARK_ATTRS[mark.type];
  if (!allowed) return null;
  const attrs = pickAttrs(mark.type, mark.attrs, allowed, false);
  if ((mark.type === "textStyle" || mark.type === "link") && !attrs) return null;
  return attrs ? { type: mark.type, attrs } : { type: mark.type };
}

function normalizeNode(node: JsonNode): JsonNode {
  const out: JsonNode = { type: node.type };
  const allowed = NODE_ATTRS[node.type];
  if (allowed) {
    const attrs = pickAttrs(node.type, node.attrs, allowed, true);
    if (attrs) out.attrs = attrs;
  }
  if (node.content) out.content = node.content.map(normalizeNode);
  if (node.text !== undefined) out.text = node.text;
  if (node.marks) {
    const marks = node.marks.map(normalizeMark).filter((m): m is JsonMark => m !== null);
    if (marks.length > 0) out.marks = marks;
  }
  return out;
}

/** Ramène le JSON TipTap au schéma exact produit/consommé par les handlers Rust. */
export function normalizeDoc(doc: unknown): unknown {
  if (!isRecord(doc) || typeof doc["type"] !== "string") return doc;
  return normalizeNode(doc as unknown as JsonNode);
}

/** Taille « 12pt » → 12 (null si illisible). Accepte aussi px (96 dpi). */
export function parseFontSize(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(pt|px)?\s*$/.exec(value);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return m[2] === "px" ? Math.round(((n * 72) / 96) * 10) / 10 : n;
}

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 72;

/** Valeur stockée dans la marque textStyle, bornée à 8–72 pt. */
export function formatFontSize(pt: number): string {
  const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, pt));
  return `${Math.round(clamped * 10) / 10}pt`;
}

export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

export const WORDS_PER_PAGE = 500;

export function estimatePages(words: number): number {
  return Math.max(1, Math.ceil(words / WORDS_PER_PAGE));
}

export const MIN_ZOOM = 50;
export const MAX_ZOOM = 200;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom)));
}

export const LOSSY_KEYS = [
  "headers_footers",
  "footnotes",
  "comments",
  "fields",
  "sections",
  "shapes",
  "tracked_changes",
  "macros",
  "page_breaks",
  "embedded_objects",
  "charts",
  "images",
  "linked_images",
  "nested_tables",
  "html",
  "scripts_embeds",
  "tables",
  "lists",
  "images_limit",
  "cells_limit",
  "depth",
];

/** Classe une clé `lossy` : connue, `node:`/`mark:` (nom extrait) ou inconnue. */
export function lossyKind(key: string): {
  kind: "known" | "node" | "mark" | "other";
  name: string;
} {
  if (key.startsWith("node:")) return { kind: "node", name: key.slice(5) };
  if (key.startsWith("mark:")) return { kind: "mark", name: key.slice(5) };
  return { kind: LOSSY_KEYS.includes(key) ? "known" : "other", name: key };
}
