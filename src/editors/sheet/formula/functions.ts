import type { Node } from "./ast";
import { dateToSerial, formatNumber, serialToParts } from "../numfmt";
import type { Locale } from "../numfmt";
import {
  ERR,
  compareValues,
  isErr,
  isMatrix,
  parseNumericText,
  toBool,
  toNumber,
  toScalar,
  toText,
} from "./values";
import type { Arg, FErr, Scalar } from "./values";

export interface EvalContext {
  currentSheet: number;
  /** Index de la feuille (-1 si inconnue) ; null = feuille courante. */
  resolveSheet(name: string | null): number;
  getCell(sheet: number, row: number, col: number): Scalar;
  getRange(sheet: number, r1: number, c1: number, r2: number, c2: number): Scalar[][];
  now(): Date;
  random(): number;
  locale: Locale;
}

export type Eval = (node: Node) => Arg;

export interface FuncDef {
  min: number;
  max: number;
  fn?: (args: Arg[], ctx: EvalContext) => Arg;
  /** Évaluation paresseuse (IF, IFERROR…). */
  lazy?: (nodes: Node[], ev: Eval, ctx: EvalContext) => Arg;
}

export const FUNCTIONS: Record<string, FuncDef> = {};

function def(
  names: string,
  min: number,
  max: number,
  fn: (args: Arg[], ctx: EvalContext) => Arg,
): void {
  for (const name of names.split("|")) FUNCTIONS[name] = { min, max, fn };
}

function lazy(name: string, min: number, max: number, fn: NonNullable<FuncDef["lazy"]>): void {
  FUNCTIONS[name] = { min, max, lazy: fn };
}

// ---------- Helpers ----------

function finite(x: number): number | FErr {
  return Number.isFinite(x) ? x : ERR.NUM;
}

/** Argument numérique scalaire. */
function num(a: Arg | undefined, dflt?: number): number | FErr {
  if (a === undefined) return dflt ?? ERR.VALUE;
  return toNumber(toScalar(a));
}

function str(a: Arg | undefined, dflt = ""): string | FErr {
  if (a === undefined) return dflt;
  return toText(toScalar(a));
}

/** Nombres des arguments (agrégats SUM, AVERAGE…) ; erreur propagée. */
function collectNumbers(args: Arg[]): number[] | FErr {
  const out: number[] = [];
  for (const a of args) {
    if (isMatrix(a)) {
      for (const row of a.m)
        for (const v of row) {
          if (isErr(v)) return v;
          if (typeof v === "number") out.push(v);
        }
    } else {
      if (isErr(a)) return a;
      if (a === null) continue;
      const n = toNumber(a);
      if (isErr(n)) return n;
      out.push(n);
    }
  }
  return out;
}

function flatten(args: Arg[]): Scalar[] {
  const out: Scalar[] = [];
  for (const a of args) {
    if (isMatrix(a)) for (const row of a.m) out.push(...row);
    else out.push(a);
  }
  return out;
}

function asMatrix(a: Arg | undefined): Scalar[][] {
  if (a === undefined) return [];
  return isMatrix(a) ? a.m : [[a]];
}

function wildcardRegex(pattern: string, flags = "i"): RegExp {
  const src = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/~\*/g, "\uE000")
    .replace(/~\?/g, "\uE001")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
    .replace(/\uE000/g, "\\*")
    .replace(/\uE001/g, "\\?");
  return new RegExp(`^${src}$`, flags + "s");
}

/** Égalité « lâche » des recherches (insensible à la casse, jokers pour le texte). */
function looseEq(cell: Scalar, key: Scalar): boolean {
  if (isErr(cell) || isErr(key)) return false;
  if (typeof key === "string" && typeof cell === "string") {
    if (/[*?]/.test(key)) return wildcardRegex(key).test(cell);
    return cell.toLowerCase() === key.toLowerCase();
  }
  if (cell === null || key === null) return false;
  if (typeof cell !== typeof key) return false;
  return compareValues(cell, key) === 0;
}

/** Critère des fonctions *IF (">=5", "abc*", 3…). */
export function criteriaMatcher(criteria: Scalar): (v: Scalar) => boolean {
  if (typeof criteria !== "string") {
    return (v) =>
      !isErr(v) && v !== null && typeof v === typeof criteria && compareValues(v, criteria) === 0;
  }
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(criteria);
  const op = m?.[1] ?? "=";
  const operand = m?.[2] ?? "";
  const n = parseNumericText(operand);
  const isNum = n !== null && operand.trim() !== "";
  const textEq = (v: Scalar): boolean => {
    if (operand === "") return v === null || v === "";
    if (typeof v === "string") return wildcardRegex(operand).test(v);
    if (typeof v === "boolean") return operand.toUpperCase() === (v ? "TRUE" : "FALSE");
    return false;
  };
  return (v) => {
    if (isErr(v)) return false;
    if (isNum) {
      if (typeof v === "number") {
        if (op === "=") return v === n;
        if (op === "<>") return v !== n;
        if (op === "<") return v < n;
        if (op === ">") return v > n;
        if (op === "<=") return v <= n;
        return v >= n;
      }
      if (op === "<>") return true;
      return op === "=" && typeof v === "string" && v.trim() === operand.trim();
    }
    if (op === "=") return textEq(v);
    if (op === "<>") return !textEq(v);
    if (typeof v !== "string") return false;
    const c = compareValues(v, operand);
    if (op === "<") return c < 0;
    if (op === ">") return c > 0;
    if (op === "<=") return c <= 0;
    return c >= 0;
  };
}

function roundTo(x: number, digits: number, mode: "round" | "up" | "down"): number {
  const f = Math.pow(10, digits);
  const y = Number((Math.abs(x) * f).toPrecision(15));
  const r = mode === "round" ? Math.floor(y + 0.5) : mode === "up" ? Math.ceil(y) : Math.floor(y);
  return (Math.sign(x) * r) / f;
}

function variance(xs: number[]): number | FErr {
  if (xs.length < 2) return ERR.DIV0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
}

// ---------- Mathématiques / statistiques ----------

def("SUM", 1, Infinity, (args) => {
  const xs = collectNumbers(args);
  return isErr(xs) ? xs : finite(xs.reduce((a, b) => a + b, 0));
});
def("AVERAGE", 1, Infinity, (args) => {
  const xs = collectNumbers(args);
  if (isErr(xs)) return xs;
  return xs.length === 0 ? ERR.DIV0 : xs.reduce((a, b) => a + b, 0) / xs.length;
});
def("MIN", 1, Infinity, (args) => {
  const xs = collectNumbers(args);
  return isErr(xs) ? xs : xs.length === 0 ? 0 : Math.min(...xs);
});
def("MAX", 1, Infinity, (args) => {
  const xs = collectNumbers(args);
  return isErr(xs) ? xs : xs.length === 0 ? 0 : Math.max(...xs);
});
def("PRODUCT", 1, Infinity, (args) => {
  const xs = collectNumbers(args);
  return isErr(xs) ? xs : finite(xs.reduce((a, b) => a * b, 1));
});
def("MEDIAN", 1, Infinity, (args) => {
  const xs = collectNumbers(args);
  if (isErr(xs)) return xs;
  if (xs.length === 0) return ERR.NUM;
  xs.sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? (xs[mid] as number) : ((xs[mid - 1] as number) + (xs[mid] as number)) / 2;
});
def("VAR|VAR.S", 1, Infinity, (args) => {
  const xs = collectNumbers(args);
  return isErr(xs) ? xs : variance(xs);
});
def("STDEV|STDEV.S", 1, Infinity, (args) => {
  const xs = collectNumbers(args);
  if (isErr(xs)) return xs;
  const v = variance(xs);
  return isErr(v) ? v : Math.sqrt(v);
});
def("COUNT", 1, Infinity, (args) => {
  let n = 0;
  for (const a of args) {
    if (isMatrix(a)) {
      for (const row of a.m) for (const v of row) if (typeof v === "number") n++;
    } else if (typeof a === "number" || typeof a === "boolean") n++;
    else if (typeof a === "string" && parseNumericText(a) !== null) n++;
  }
  return n;
});
def("COUNTA", 1, Infinity, (args) => flatten(args).filter((v) => v !== null).length);
def("COUNTBLANK", 1, 1, (args) => flatten(args).filter((v) => v === null || v === "").length);

def("COUNTIF", 2, 2, ([range, crit]) => {
  const match = criteriaMatcher(toScalar(crit as Arg));
  return flatten([range as Arg]).filter(match).length;
});

function conditional(args: Arg[], average: boolean): Arg {
  const [range, crit, sumRange] = args;
  const match = criteriaMatcher(toScalar(crit as Arg));
  const rows = asMatrix(range);
  const target = sumRange === undefined ? rows : asMatrix(sumRange);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < (rows[i]?.length ?? 0); j++) {
      if (!match((rows[i] as Scalar[])[j] as Scalar)) continue;
      const v = target[i]?.[j] ?? null;
      if (isErr(v)) return v;
      if (typeof v === "number") {
        sum += v;
        count++;
      }
    }
  }
  if (average) return count === 0 ? ERR.DIV0 : sum / count;
  return sum;
}
def("SUMIF", 2, 3, (args) => conditional(args, false));
def("AVERAGEIF", 2, 3, (args) => conditional(args, true));

def("ROUND", 2, 2, ([a, d]) => {
  const x = num(a);
  const k = num(d);
  if (isErr(x)) return x;
  if (isErr(k)) return k;
  return finite(roundTo(x, Math.trunc(k), "round"));
});
def("ROUNDUP", 2, 2, ([a, d]) => {
  const x = num(a);
  const k = num(d);
  if (isErr(x)) return x;
  if (isErr(k)) return k;
  return finite(roundTo(x, Math.trunc(k), "up"));
});
def("ROUNDDOWN", 2, 2, ([a, d]) => {
  const x = num(a);
  const k = num(d);
  if (isErr(x)) return x;
  if (isErr(k)) return k;
  return finite(roundTo(x, Math.trunc(k), "down"));
});
def("INT", 1, 1, ([a]) => {
  const x = num(a);
  return isErr(x) ? x : Math.floor(x);
});
def("MOD", 2, 2, ([a, b]) => {
  const x = num(a);
  const y = num(b);
  if (isErr(x)) return x;
  if (isErr(y)) return y;
  if (y === 0) return ERR.DIV0;
  return x - y * Math.floor(x / y);
});
def("ABS", 1, 1, ([a]) => {
  const x = num(a);
  return isErr(x) ? x : Math.abs(x);
});
def("SQRT", 1, 1, ([a]) => {
  const x = num(a);
  if (isErr(x)) return x;
  return x < 0 ? ERR.NUM : Math.sqrt(x);
});
def("POWER", 2, 2, ([a, b]) => {
  const x = num(a);
  const y = num(b);
  if (isErr(x)) return x;
  if (isErr(y)) return y;
  if (x === 0 && y < 0) return ERR.DIV0;
  return finite(Math.pow(x, y));
});
def("PI", 0, 0, () => Math.PI);
def("RAND", 0, 0, (_a, ctx) => ctx.random());

// ---------- Logique ----------

lazy("IF", 2, 3, (nodes, ev) => {
  const c = toBool(toScalar(ev(nodes[0] as Node)));
  if (isErr(c)) return c;
  if (c) return toScalar(ev(nodes[1] as Node));
  return nodes[2] === undefined ? false : toScalar(ev(nodes[2]));
});
lazy("IFERROR", 2, 2, (nodes, ev) => {
  const v = toScalar(ev(nodes[0] as Node));
  return isErr(v) ? toScalar(ev(nodes[1] as Node)) : v;
});

function collectBools(args: Arg[]): boolean[] | FErr {
  const out: boolean[] = [];
  for (const a of args) {
    if (isMatrix(a)) {
      for (const row of a.m)
        for (const v of row) {
          if (isErr(v)) return v;
          if (typeof v === "boolean") out.push(v);
          else if (typeof v === "number") out.push(v !== 0);
        }
    } else {
      const b = toBool(a);
      if (isErr(b)) return b;
      out.push(b);
    }
  }
  return out.length === 0 ? ERR.VALUE : out;
}
def("AND", 1, Infinity, (args) => {
  const bs = collectBools(args);
  return isErr(bs) ? bs : bs.every(Boolean);
});
def("OR", 1, Infinity, (args) => {
  const bs = collectBools(args);
  return isErr(bs) ? bs : bs.some(Boolean);
});
def("XOR", 1, Infinity, (args) => {
  const bs = collectBools(args);
  return isErr(bs) ? bs : bs.filter(Boolean).length % 2 === 1;
});
def("NOT", 1, 1, ([a]) => {
  const b = toBool(toScalar(a as Arg));
  return isErr(b) ? b : !b;
});
def("ISBLANK", 1, 1, ([a]) => toScalar(a as Arg) === null);
def("ISNUMBER", 1, 1, ([a]) => typeof toScalar(a as Arg) === "number");
def("ISTEXT", 1, 1, ([a]) => typeof toScalar(a as Arg) === "string");
def("ISERROR", 1, 1, ([a]) => isErr(toScalar(a as Arg)));

// ---------- Texte ----------

def("LEN", 1, 1, ([a]) => {
  const s = str(a);
  return isErr(s) ? s : s.length;
});
def("LEFT", 1, 2, ([a, n]) => {
  const s = str(a);
  const k = num(n, 1);
  if (isErr(s)) return s;
  if (isErr(k)) return k;
  return k < 0 ? ERR.VALUE : s.slice(0, Math.trunc(k));
});
def("RIGHT", 1, 2, ([a, n]) => {
  const s = str(a);
  const k = num(n, 1);
  if (isErr(s)) return s;
  if (isErr(k)) return k;
  if (k < 0) return ERR.VALUE;
  return Math.trunc(k) === 0 ? "" : s.slice(-Math.trunc(k));
});
def("MID", 3, 3, ([a, start, n]) => {
  const s = str(a);
  const i = num(start);
  const k = num(n);
  if (isErr(s)) return s;
  if (isErr(i)) return i;
  if (isErr(k)) return k;
  if (i < 1 || k < 0) return ERR.VALUE;
  return s.slice(Math.trunc(i) - 1, Math.trunc(i) - 1 + Math.trunc(k));
});
def("UPPER", 1, 1, ([a]) => {
  const s = str(a);
  return isErr(s) ? s : s.toUpperCase();
});
def("LOWER", 1, 1, ([a]) => {
  const s = str(a);
  return isErr(s) ? s : s.toLowerCase();
});
def("PROPER", 1, 1, ([a]) => {
  const s = str(a);
  if (isErr(s)) return s;
  return s
    .toLowerCase()
    .replace(/(^|[^\p{L}])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase());
});
def("TRIM", 1, 1, ([a]) => {
  const s = str(a);
  return isErr(s) ? s : s.replace(/^ +| +$/g, "").replace(/ {2,}/g, " ");
});

function concatAll(args: Arg[]): string | FErr {
  let out = "";
  for (const v of flatten(args)) {
    const t = toText(v);
    if (isErr(t)) return t;
    out += t;
  }
  return out;
}
def("CONCAT|CONCATENATE", 1, Infinity, (args) => concatAll(args));
def("TEXTJOIN", 3, Infinity, ([delim, ignore, ...rest]) => {
  const d = str(delim);
  const ig = toBool(toScalar(ignore as Arg));
  if (isErr(d)) return d;
  if (isErr(ig)) return ig;
  const parts: string[] = [];
  for (const v of flatten(rest)) {
    const t = toText(v);
    if (isErr(t)) return t;
    if (ig && t === "") continue;
    parts.push(t);
  }
  return parts.join(d);
});
def("SUBSTITUTE", 3, 4, ([a, o, n, inst]) => {
  const s = str(a);
  const oldT = str(o);
  const newT = str(n);
  if (isErr(s)) return s;
  if (isErr(oldT)) return oldT;
  if (isErr(newT)) return newT;
  if (oldT === "") return s;
  if (inst === undefined) return s.split(oldT).join(newT);
  const k = num(inst);
  if (isErr(k)) return k;
  if (k < 1) return ERR.VALUE;
  let idx = -1;
  for (let i = 0; i < k; i++) {
    idx = s.indexOf(oldT, idx + 1);
    if (idx < 0) return s;
  }
  return s.slice(0, idx) + newT + s.slice(idx + oldT.length);
});
def("FIND", 2, 3, ([f, w, st]) => {
  const find = str(f);
  const within = str(w);
  const start = num(st, 1);
  if (isErr(find)) return find;
  if (isErr(within)) return within;
  if (isErr(start)) return start;
  if (start < 1 || start > within.length + 1) return ERR.VALUE;
  const i = within.indexOf(find, Math.trunc(start) - 1);
  return i < 0 ? ERR.VALUE : i + 1;
});
def("SEARCH", 2, 3, ([f, w, st]) => {
  const find = str(f);
  const within = str(w);
  const start = num(st, 1);
  if (isErr(find)) return find;
  if (isErr(within)) return within;
  if (isErr(start)) return start;
  if (start < 1 || start > within.length + 1) return ERR.VALUE;
  const src = wildcardRegex(find, "i").source.slice(1, -1);
  const m = new RegExp(src, "is").exec(within.slice(Math.trunc(start) - 1));
  return m ? m.index + Math.trunc(start) : ERR.VALUE;
});
def("VALUE", 1, 1, ([a]) => {
  const v = toScalar(a as Arg);
  if (isErr(v)) return v;
  if (typeof v === "string") {
    const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v.trim());
    if (d) return dateToSerial(Number(d[1]), Number(d[2]), Number(d[3]));
  }
  return toNumber(v);
});
def("TEXT", 2, 2, ([a, f], ctx) => {
  const v = toScalar(a as Arg);
  const fmt = str(f);
  if (isErr(v)) return v;
  if (isErr(fmt)) return fmt;
  const n = typeof v === "string" ? parseNumericText(v) : toNumber(v);
  if (n === null) return v as string;
  if (isErr(n)) return n;
  return formatNumber(n, fmt, ctx.locale);
});

// ---------- Recherche ----------

function flatVector(a: Arg | undefined): Scalar[] {
  return flatten(a === undefined ? [] : [a]);
}

def("MATCH", 2, 3, ([key, arr, type], ctx) => {
  void ctx;
  const k = toScalar(key as Arg);
  const t = num(type, 1);
  if (isErr(k)) return k;
  if (isErr(t)) return t;
  const xs = flatVector(arr);
  if (t === 0) {
    const i = xs.findIndex((x) => looseEq(x, k));
    return i < 0 ? ERR.NA : i + 1;
  }
  let best = -1;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] as Scalar;
    if (x === null || isErr(x) || typeof x !== typeof k) continue;
    const c = compareValues(x, k);
    if (t > 0 ? c <= 0 : c >= 0) {
      if (
        best < 0 ||
        (t > 0
          ? compareValues(x, xs[best] as Scalar) >= 0
          : compareValues(x, xs[best] as Scalar) <= 0)
      )
        best = i;
    }
  }
  return best < 0 ? ERR.NA : best + 1;
});

def("INDEX", 2, 3, ([arr, r, c]) => {
  const m = asMatrix(arr);
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  let row = num(r);
  let col = num(c, 0);
  if (isErr(row)) return row;
  if (isErr(col)) return col;
  row = Math.trunc(row);
  col = Math.trunc(col);
  if (c === undefined && rows === 1 && cols > 1) {
    col = row;
    row = 1;
  } else if (c === undefined) col = cols === 1 ? 1 : 0;
  if (row < 0 || col < 0 || row > rows || col > cols) return ERR.REF;
  if (row === 0 && col === 0) return { m };
  if (row === 0) return { m: m.map((line) => [line[col - 1] ?? null]) };
  if (col === 0) return cols === 1 ? (m[row - 1]?.[0] ?? null) : { m: [m[row - 1] ?? []] };
  return m[row - 1]?.[col - 1] ?? null;
});

function approxIndex(keys: Scalar[], key: Scalar): number {
  let best = -1;
  for (let i = 0; i < keys.length; i++) {
    const x = keys[i] as Scalar;
    if (x === null || isErr(x) || typeof x !== typeof key) continue;
    if (compareValues(x, key) <= 0) best = i;
    else break;
  }
  return best;
}

function lookup2d(args: Arg[], vertical: boolean): Arg {
  const [key, table, index, approx] = args;
  const k = toScalar(key as Arg);
  const idx = num(index);
  const exact = approx === undefined ? false : toBool(toScalar(approx)) === false;
  if (isErr(k)) return k;
  if (isErr(idx)) return idx;
  const m = asMatrix(table);
  const n = Math.trunc(idx);
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  if (n < 1) return ERR.VALUE;
  if (n > (vertical ? cols : rows)) return ERR.REF;
  const keys = vertical ? m.map((r) => r[0] ?? null) : (m[0] ?? []);
  const pos = exact ? keys.findIndex((x) => looseEq(x, k)) : approxIndex(keys, k);
  if (pos < 0) return ERR.NA;
  return (vertical ? m[pos]?.[n - 1] : m[n - 1]?.[pos]) ?? null;
}
def("VLOOKUP", 3, 4, (args) => lookup2d(args, true));
def("HLOOKUP", 3, 4, (args) => lookup2d(args, false));

def("XLOOKUP", 3, 6, ([key, lookupArr, returnArr, notFound, mode, searchMode]) => {
  const k = toScalar(key as Arg);
  const mm = num(mode, 0);
  const sm = num(searchMode, 1);
  if (isErr(k)) return k;
  if (isErr(mm)) return mm;
  if (isErr(sm)) return sm;
  const keys = flatVector(lookupArr);
  const order = keys.map((_x, i) => i);
  if (sm < 0) order.reverse();
  let pos = order.find((i) => looseEq(keys[i] as Scalar, k)) ?? -1;
  if (pos < 0 && (mm === -1 || mm === 1)) {
    let best = -1;
    for (const i of order) {
      const x = keys[i] as Scalar;
      if (x === null || isErr(x) || typeof x !== typeof k) continue;
      const c = compareValues(x, k);
      if (mm === -1 ? c < 0 : c > 0) {
        if (
          best < 0 ||
          (mm === -1
            ? compareValues(x, keys[best] as Scalar) > 0
            : compareValues(x, keys[best] as Scalar) < 0)
        )
          best = i;
      }
    }
    pos = best;
  }
  if (pos < 0) return notFound === undefined ? ERR.NA : notFound;
  const ret = asMatrix(returnArr);
  const asColumn = asMatrix(lookupArr).length > 1 || (asMatrix(lookupArr)[0]?.length ?? 0) === 1;
  if (asColumn) {
    const line = ret[pos];
    if (!line) return ERR.REF;
    return line.length === 1 ? (line[0] ?? null) : { m: [line] };
  }
  const col = ret.map((line) => line[pos] ?? null);
  return col.length === 1 ? (col[0] ?? null) : { m: col.map((x) => [x]) };
});

// ---------- Dates ----------

def("TODAY", 0, 0, (_a, ctx) => {
  const d = ctx.now();
  return dateToSerial(d.getFullYear(), d.getMonth() + 1, d.getDate());
});
def("NOW", 0, 0, (_a, ctx) => {
  const d = ctx.now();
  return dateToSerial(
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  );
});
def("DATE", 3, 3, ([y, m, d]) => {
  const yy = num(y);
  const mm = num(m);
  const dd = num(d);
  if (isErr(yy)) return yy;
  if (isErr(mm)) return mm;
  if (isErr(dd)) return dd;
  const year = Math.trunc(yy);
  if (year < 0 || year > 9999) return ERR.NUM;
  const full = year < 1900 ? year + 1900 : year;
  const date = new Date(Date.UTC(2000, 0, 1));
  date.setUTCFullYear(full, Math.trunc(mm) - 1, Math.trunc(dd));
  return dateToSerial(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
});
function datePart(pick: "y" | "m" | "d"): (args: Arg[]) => Arg {
  return ([a]) => {
    const x = num(a);
    if (isErr(x)) return x;
    if (x < 0) return ERR.NUM;
    return serialToParts(x)[pick];
  };
}
def("YEAR", 1, 1, datePart("y"));
def("MONTH", 1, 1, datePart("m"));
def("DAY", 1, 1, datePart("d"));
