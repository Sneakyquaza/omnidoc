import { parseDocument } from "yaml";
import { parse as parseToml, TomlError } from "smol-toml";
import { JsonSyntaxError, parseJsonTree } from "./tree";

export interface SyntaxIssue {
  from: number;
  to: number;
  /** Message brut (bibliothèque) ou clé i18n `lint.json.*` si `key` est défini. */
  message: string;
  key?: string;
}

/** Offset de début d'une ligne/colonne (1-based) ; borné au texte. */
export function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf("\n", offset);
    if (nl < 0) return text.length;
    offset = nl + 1;
  }
  return Math.min(text.length, offset + Math.max(0, column - 1));
}

/** Ligne/colonne (1-based) d'un offset. */
export function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    last = i;
  }
  return { line, column: offset - last };
}

function singleChar(text: string, pos: number): { from: number; to: number } {
  const from = Math.min(pos, text.length);
  return { from, to: Math.min(text.length, from + 1) };
}

export function validateJson(text: string): SyntaxIssue[] {
  if (text.trim() === "") return [];
  try {
    parseJsonTree(text);
    return [];
  } catch (e) {
    if (e instanceof JsonSyntaxError) {
      return [{ ...singleChar(text, e.pos), message: e.message, key: e.message }];
    }
    return [{ from: 0, to: 0, message: String(e) }];
  }
}

export function validateYaml(text: string): SyntaxIssue[] {
  const doc = parseDocument(text);
  return doc.errors.map((err) => {
    const [from, to] = err.pos;
    return {
      from: Math.min(from, text.length),
      to: Math.min(Math.max(to, from + 1), text.length),
      message: err.message.split("\n")[0] ?? err.message,
    };
  });
}

export function validateToml(text: string): SyntaxIssue[] {
  try {
    parseToml(text);
    return [];
  } catch (e) {
    if (e instanceof TomlError) {
      const from = offsetOf(text, e.line, e.column);
      const to = text.indexOf("\n", from);
      return [
        {
          from,
          to: to < 0 ? text.length : Math.max(to, from),
          message: e.message.split("\n")[0] ?? e.message,
        },
      ];
    }
    return [{ from: 0, to: 0, message: String(e) }];
  }
}

export function validateXml(text: string): SyntaxIssue[] {
  if (text.trim() === "") return [];
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (!err) return [];
  const raw = err.textContent ?? "XML";
  // Chrome/WebKit/jsdom : « line 3 at column 5 » ; Firefox : « Line Number 3, Column 5 »
  const m =
    /line\s+(?:number\s+)?(\d+)[\s,]+(?:at\s+)?column\s+(\d+)/i.exec(raw) ??
    /(\d+):(\d+)/.exec(raw);
  const message = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^Below is a rendering/i.test(l))[0] as string;
  if (!m) return [{ from: 0, to: 0, message }];
  const from = offsetOf(text, Number(m[1]), Number(m[2]));
  return [{ ...singleChar(text, from), message }];
}

/** Validateur pour un langage, ou `null` si le langage n'est pas validé. */
export function validatorFor(language: string): ((text: string) => SyntaxIssue[]) | null {
  switch (language) {
    case "json":
      return validateJson;
    case "yaml":
      return validateYaml;
    case "toml":
      return validateToml;
    case "xml":
      return validateXml;
    default:
      return null;
  }
}

/** JSON indenté sur 2 espaces ; lève si invalide. */
export function formatJson(text: string): string {
  parseJsonTree(text);
  return JSON.stringify(JSON.parse(text), null, 2);
}

/** Pretty-print XML simple (indentation de 2 espaces, texte inline conservé). */
export function formatXml(text: string): string {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("xml");
  const tokens = text
    .replace(/>\s+</g, "><")
    .trim()
    .split(/(<[^>]+>)/)
    .filter(Boolean);
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    if (!tok.startsWith("<")) {
      out.push("  ".repeat(depth) + tok.trim());
      continue;
    }
    const closing = tok.startsWith("</");
    const selfClosing = /\/>$/.test(tok) || /^<[?!]/.test(tok);
    if (closing) depth = Math.max(0, depth - 1);
    // <a>texte</a> reste sur une ligne
    const next = tokens[i + 1];
    const after = tokens[i + 2];
    if (!closing && !selfClosing && next && !next.startsWith("<") && after?.startsWith("</")) {
      out.push("  ".repeat(depth) + tok + next + after);
      i += 2;
      continue;
    }
    out.push("  ".repeat(depth) + tok);
    if (!closing && !selfClosing) depth++;
  }
  return out.join("\n");
}
