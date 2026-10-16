import type { CornerParts, Node } from "./ast";
import { parseFormula } from "./parser";
import { cellName } from "./ref";

/** Réécriture de formules : décalage relatif, insertion/suppression, renommage de feuille. */

function quoteSheet(name: string): string {
  return /^[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name)
    ? name
    : `'${name.replace(/'/g, "''")}'`;
}

function corner(c: CornerParts): string {
  return cellName(c.row, c.col, c.absRow, c.absCol);
}

/** Texte d'une formule à partir de son arbre. */
export function unparse(node: Node): string {
  switch (node.t) {
    case "num":
      return String(node.v);
    case "str":
      return `"${node.v.replace(/"/g, '""')}"`;
    case "bool":
      return node.v ? "TRUE" : "FALSE";
    case "err":
      return node.v;
    case "empty":
      return "";
    case "name":
      return node.name;
    case "ref":
      return (node.sheet === null ? "" : `${quoteSheet(node.sheet)}!`) + corner(node);
    case "range":
      return (
        (node.sheet === null ? "" : `${quoteSheet(node.sheet)}!`) +
        `${corner(node.a)}:${corner(node.b)}`
      );
    case "unary":
      return node.op + unparse(node.arg);
    case "percent":
      return `${unparse(node.arg)}%`;
    case "paren":
      return `(${unparse(node.arg)})`;
    case "bin":
      return `${unparse(node.l)}${node.op}${unparse(node.r)}`;
    case "call":
      return `${node.name}(${node.args.map(unparse).join(",")})`;
  }
}

const REF_ERR: Node = { t: "err", v: "#REF!" };

/** Remplace les références d'un arbre ; `fn` renvoie le nouveau nœud. */
export function mapRefs(node: Node, fn: (n: Node & { t: "ref" | "range" }) => Node): Node {
  switch (node.t) {
    case "ref":
    case "range":
      return fn(node);
    case "unary":
    case "percent":
    case "paren":
      return { ...node, arg: mapRefs(node.arg, fn) };
    case "bin":
      return { ...node, l: mapRefs(node.l, fn), r: mapRefs(node.r, fn) };
    case "call":
      return { ...node, args: node.args.map((a) => mapRefs(a, fn)) };
    default:
      return node;
  }
}

function rewrite(f: string, fn: (n: Node & { t: "ref" | "range" }) => Node): string {
  let ast: Node;
  try {
    ast = parseFormula(f);
  } catch {
    return f;
  }
  return unparse(mapRefs(ast, fn));
}

function shiftCorner(c: CornerParts, dr: number, dc: number): CornerParts | null {
  const row = c.absRow ? c.row : c.row + dr;
  const col = c.absCol ? c.col : c.col + dc;
  if (row < 0 || col < 0) return null;
  return { ...c, row, col };
}

/** Décale les références relatives (copier/coller, remplissage, tri). */
export function offsetFormula(f: string, dr: number, dc: number): string {
  if (dr === 0 && dc === 0) return f;
  return rewrite(f, (n) => {
    if (n.t === "ref") {
      const c = shiftCorner(n, dr, dc);
      return c ? { ...n, row: c.row, col: c.col } : REF_ERR;
    }
    const a = shiftCorner(n.a, dr, dc);
    const b = shiftCorner(n.b, dr, dc);
    return a && b ? { ...n, a, b } : REF_ERR;
  });
}

export type Axis = "row" | "col";

function sameSheet(a: string | null, formulaSheet: string, target: string): boolean {
  return (a ?? formulaSheet).toLowerCase() === target.toLowerCase();
}

function adjustIndex(v: number, index: number, count: number): number {
  return v >= index ? v + count : v;
}

/**
 * Adapte une formule (située dans `formulaSheet`) à l'insertion (`count` > 0) ou à la
 * suppression (`count` < 0, |count| éléments à partir de `index`) de lignes/colonnes de `target`.
 */
export function adjustForStructure(
  f: string,
  formulaSheet: string,
  target: string,
  axis: Axis,
  index: number,
  count: number,
): string {
  return rewrite(f, (n) => {
    if (!sameSheet(n.sheet, formulaSheet, target)) return n;
    const get = (c: CornerParts) => (axis === "row" ? c.row : c.col);
    const set = (c: CornerParts, v: number): CornerParts =>
      axis === "row" ? { ...c, row: v } : { ...c, col: v };
    if (count > 0) {
      if (n.t === "ref") return { ...n, ...set(n, adjustIndex(get(n), index, count)) };
      return {
        ...n,
        a: set(n.a, adjustIndex(get(n.a), index, count)),
        b: set(n.b, adjustIndex(get(n.b), index, count)),
      };
    }
    const removed = -count;
    const end = index + removed; // premier indice conservé après la zone supprimée
    if (n.t === "ref") {
      const v = get(n);
      if (v >= index && v < end) return REF_ERR;
      return { ...n, ...set(n, v >= end ? v - removed : v) };
    }
    const lo = Math.min(get(n.a), get(n.b));
    const hi = Math.max(get(n.a), get(n.b));
    const newLo = lo < index ? lo : lo >= end ? lo - removed : index;
    const newHi = hi < index ? hi : hi >= end ? hi - removed : index - 1;
    if (newHi < newLo) return REF_ERR;
    const flip = get(n.a) > get(n.b);
    return {
      ...n,
      a: set(n.a, flip ? newHi : newLo),
      b: set(n.b, flip ? newLo : newHi),
    };
  });
}

export function renameSheetInFormula(f: string, oldName: string, newName: string): string {
  return rewrite(f, (n) =>
    n.sheet !== null && n.sheet.toLowerCase() === oldName.toLowerCase()
      ? { ...n, sheet: newName }
      : n,
  );
}

export function removeSheetFromFormula(f: string, name: string): string {
  return rewrite(f, (n) =>
    n.sheet !== null && n.sheet.toLowerCase() === name.toLowerCase() ? REF_ERR : n,
  );
}
