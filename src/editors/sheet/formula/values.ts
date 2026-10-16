/** Valeurs du moteur de formules. */

export interface FErr {
  readonly err: string;
}

export type Scalar = number | string | boolean | null | FErr;

/** Plage matérialisée (lignes de valeurs). */
export interface Matrix {
  readonly m: Scalar[][];
}

export type Arg = Scalar | Matrix;

export const ERR = {
  DIV0: { err: "#DIV/0!" },
  VALUE: { err: "#VALUE!" },
  REF: { err: "#REF!" },
  NAME: { err: "#NAME?" },
  NA: { err: "#N/A" },
  NUM: { err: "#NUM!" },
  NULL: { err: "#NULL!" },
  CYCLE: { err: "#CYCLE!" },
} as const satisfies Record<string, FErr>;

export function isErr(v: unknown): v is FErr {
  return typeof v === "object" && v !== null && "err" in v;
}

export function isMatrix(v: unknown): v is Matrix {
  return typeof v === "object" && v !== null && "m" in v;
}

export function errFromCode(code: string): FErr {
  const up = code.toUpperCase();
  for (const e of Object.values(ERR)) if (e.err === up) return e;
  return ERR.VALUE;
}

/** Premier coin d'une plage (intersection implicite simplifiée). */
export function toScalar(a: Arg): Scalar {
  if (isMatrix(a)) return a.m[0]?.[0] ?? null;
  return a;
}

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Nombre dans un texte ("12.5", "1,234.5", "12%") ; null sinon. */
export function parseNumericText(text: string): number | null {
  let s = text.trim();
  if (s === "") return null;
  let pct = false;
  if (s.endsWith("%")) {
    pct = true;
    s = s.slice(0, -1).trim();
  }
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  if (!NUM_RE.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

/** Représentation texte d'un nombre (comme la conversion automatique d'Excel). */
export function numberToText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return String(Number(n.toPrecision(15)));
}

export function toNumber(v: Scalar): number | FErr {
  if (isErr(v)) return v;
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = parseNumericText(v);
  return n === null ? ERR.VALUE : n;
}

export function toText(v: Scalar): string | FErr {
  if (isErr(v)) return v;
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return numberToText(v);
}

export function toBool(v: Scalar): boolean | FErr {
  if (isErr(v)) return v;
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const up = v.trim().toUpperCase();
  if (up === "TRUE") return true;
  if (up === "FALSE") return false;
  return ERR.VALUE;
}

function rank(v: Scalar): number {
  if (typeof v === "number") return 0;
  if (typeof v === "string") return 1;
  return 2;
}

/** Comparaison à la Excel : nombres < textes < booléens ; texte insensible à la casse ; vide = 0 / "". */
export function compareValues(a: Scalar, b: Scalar): number {
  let x = a;
  let y = b;
  if (x === null && y === null) return 0;
  if (x === null) x = typeof y === "string" ? "" : typeof y === "boolean" ? false : 0;
  if (y === null) y = typeof x === "string" ? "" : typeof x === "boolean" ? false : 0;
  if (isErr(x) || isErr(y)) return 0;
  const rx = rank(x);
  const ry = rank(y);
  if (rx !== ry) return rx < ry ? -1 : 1;
  if (typeof x === "number" && typeof y === "number") return x < y ? -1 : x > y ? 1 : 0;
  if (typeof x === "string" && typeof y === "string") {
    const lx = x.toLowerCase();
    const ly = y.toLowerCase();
    return lx < ly ? -1 : lx > ly ? 1 : 0;
  }
  return Number(x) - Number(y);
}
