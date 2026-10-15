import { parseDocument, isMap, isSeq, isScalar, isPair } from "yaml";
import type { Node as YamlNode } from "yaml";
import { parse as parseToml } from "smol-toml";

export type TreeKind =
  "object" | "array" | "string" | "number" | "boolean" | "null" | "element" | "attribute" | "text";

export interface TreeNode {
  id: string;
  label: string;
  kind: TreeKind;
  /** Aperçu de la valeur pour les feuilles. */
  value?: string;
  /** Offset approximatif dans le texte source. */
  offset?: number;
  children: TreeNode[];
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
  expanded: boolean;
}

export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
  }
}

/** Analyse JSON stricte avec positions ; lève `JsonSyntaxError` (message = clé i18n). */
export function parseJsonTree(text: string): TreeNode {
  let i = 0;
  const fail = (msg: string, at = i): never => {
    throw new JsonSyntaxError(msg, at);
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i] as string)) i++;
  };
  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length) {
      const c = text[i] as string;
      if (c === '"') {
        i++;
        try {
          return JSON.parse(text.slice(start, i)) as string;
        } catch {
          return fail("invalidString", start);
        }
      }
      if (c === "\\") i += 2;
      else if (c < " ") return fail("controlChar");
      else i++;
    }
    return fail("unterminatedString", start);
  };
  let counter = 0;
  const value = (label: string): TreeNode => {
    ws();
    const offset = i;
    const id = `n${counter++}`;
    const c = text[i];
    if (c === undefined) return fail("unexpectedEnd");
    if (c === "{") {
      i++;
      const children: TreeNode[] = [];
      ws();
      if (text[i] === "}") i++;
      else {
        for (;;) {
          ws();
          if (text[i] !== '"') return fail(text[i] === undefined ? "unexpectedEnd" : "expectedKey");
          const key = str();
          ws();
          if (text[i] !== ":")
            return fail(text[i] === undefined ? "unexpectedEnd" : "expectedColon");
          i++;
          children.push(value(key));
          ws();
          if (text[i] === ",") i++;
          else if (text[i] === "}") {
            i++;
            break;
          } else return fail(text[i] === undefined ? "unexpectedEnd" : "expectedCommaOrBrace");
        }
      }
      return { id, label, kind: "object", offset, children, value: `{${children.length}}` };
    }
    if (c === "[") {
      i++;
      const children: TreeNode[] = [];
      ws();
      if (text[i] === "]") i++;
      else {
        for (;;) {
          children.push(value(String(children.length)));
          ws();
          if (text[i] === ",") i++;
          else if (text[i] === "]") {
            i++;
            break;
          } else return fail(text[i] === undefined ? "unexpectedEnd" : "expectedCommaOrBracket");
        }
      }
      return { id, label, kind: "array", offset, children, value: `[${children.length}]` };
    }
    if (c === '"') return { id, label, kind: "string", offset, children: [], value: str() };
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      text.slice(i, i + 64),
    );
    if (!m) return fail("unexpectedToken");
    i += m[0].length;
    const kind: TreeKind =
      m[0] === "true" || m[0] === "false" ? "boolean" : m[0] === "null" ? "null" : "number";
    return { id, label, kind, offset, children: [], value: m[0] };
  };
  const root = value("$");
  ws();
  if (i < text.length) fail("unexpectedToken");
  return root;
}

function fromPlain(
  label: string,
  v: unknown,
  cursor: { pos: number; n: number },
  text: string,
): TreeNode {
  const id = `g${cursor.n++}`;
  let offset: number | undefined;
  if (/^[\w-]+$/.test(label) && Number.isNaN(Number(label))) {
    const m = new RegExp(`(^|[\\s\\[,{])"?${label}"?\\s*=`, "m").exec(text.slice(cursor.pos));
    if (m) {
      offset = cursor.pos + m.index + (m[1] ?? "").length;
      cursor.pos = offset + 1;
    }
  }
  if (Array.isArray(v)) {
    return {
      id,
      label,
      kind: "array",
      offset,
      value: `[${v.length}]`,
      children: v.map((x, k) => fromPlain(String(k), x, cursor, text)),
    };
  }
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const entries = Object.entries(v);
    return {
      id,
      label,
      kind: "object",
      offset,
      value: `{${entries.length}}`,
      children: entries.map(([k, x]) => fromPlain(k, x, cursor, text)),
    };
  }
  const kind: TreeKind =
    typeof v === "number" || typeof v === "bigint"
      ? "number"
      : typeof v === "boolean"
        ? "boolean"
        : v === null
          ? "null"
          : "string";
  return {
    id,
    label,
    kind,
    offset,
    children: [],
    value: v instanceof Date ? v.toISOString() : String(v),
  };
}

export function parseTomlTree(text: string): TreeNode {
  return fromPlain("$", parseToml(text), { pos: 0, n: 0 }, text);
}

function yamlNode(label: string, node: unknown, id: { n: number }): TreeNode {
  const nid = `y${id.n++}`;
  const offset = (node as YamlNode | null)?.range?.[0];
  if (isMap(node)) {
    const children = node.items.map((pair) => {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      const child = yamlNode(key, pair.value, id);
      const keyStart = (pair.key as YamlNode | null)?.range?.[0];
      return keyStart === undefined ? child : { ...child, offset: keyStart };
    });
    return { id: nid, label, kind: "object", offset, children, value: `{${children.length}}` };
  }
  if (isSeq(node)) {
    const children = node.items.map((x, k) => yamlNode(String(k), isPair(x) ? x.value : x, id));
    return { id: nid, label, kind: "array", offset, children, value: `[${children.length}]` };
  }
  const v = isScalar(node) ? node.value : null;
  const kind: TreeKind =
    typeof v === "number"
      ? "number"
      : typeof v === "boolean"
        ? "boolean"
        : v === null
          ? "null"
          : "string";
  return { id: nid, label, kind, offset, children: [], value: v === null ? "null" : String(v) };
}

/** Arbre YAML (premier document). Lève si le YAML contient des erreurs. */
export function parseYamlTree(text: string): TreeNode {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw doc.errors[0];
  return yamlNode("$", doc.contents, { n: 0 });
}

/** Arbre XML via DOMParser ; lève si le XML est mal formé. */
export function parseXmlTree(text: string): TreeNode {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error(err.textContent ?? "XML");
  let n = 0;
  let cursor = 0;
  const build = (el: Element): TreeNode => {
    const at = text.indexOf(`<${el.tagName}`, cursor);
    const offset = at < 0 ? undefined : at;
    if (at >= 0) cursor = at + 1;
    const children: TreeNode[] = [];
    for (const a of Array.from(el.attributes)) {
      children.push({
        id: `x${n++}`,
        label: `@${a.name}`,
        kind: "attribute",
        value: a.value,
        offset,
        children: [],
      });
    }
    let leafText = "";
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === 1) children.push(build(c as Element));
      else if (c.nodeType === 3 || c.nodeType === 4) leafText += c.textContent ?? "";
    }
    leafText = leafText.trim();
    if (leafText && children.length === 0) {
      return {
        id: `x${n++}`,
        label: el.tagName,
        kind: "element",
        value: leafText,
        offset,
        children,
      };
    }
    if (leafText) {
      children.push({ id: `x${n++}`, label: "#text", kind: "text", value: leafText, children: [] });
    }
    return { id: `x${n++}`, label: el.tagName, kind: "element", offset, children };
  };
  return build(doc.documentElement);
}

/** Langages pour lesquels un arbre est disponible. */
export const TREE_LANGUAGES = ["json", "yaml", "toml", "xml"];

/** Construit l'arbre d'un langage structuré ; `null` si non applicable. */
export function buildTree(language: string, text: string): TreeNode | null {
  switch (language) {
    case "json":
      return parseJsonTree(text);
    case "yaml":
      return parseYamlTree(text);
    case "toml":
      return parseTomlTree(text);
    case "xml":
      return parseXmlTree(text);
    default:
      return null;
  }
}

export function countNodes(node: TreeNode): number {
  let n = 1;
  for (const c of node.children) n += countNodes(c);
  return n;
}

/** Aplatit l'arbre selon les nœuds dépliés (pour la virtualisation). */
export function flattenTree(root: TreeNode, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: TreeNode, depth: number) => {
    const isOpen = node.children.length > 0 && expanded.has(node.id);
    rows.push({ node, depth, expanded: isOpen });
    if (isOpen) for (const c of node.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return rows;
}
