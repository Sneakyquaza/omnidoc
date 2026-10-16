import type { Node } from "./ast";
import { FUNCTIONS } from "./functions";
import type { EvalContext } from "./functions";
import { ERR, compareValues, errFromCode, isErr, toNumber, toScalar, toText } from "./values";
import type { Arg, Scalar } from "./values";

export type { EvalContext } from "./functions";

function finite(x: number): Scalar {
  return Number.isFinite(x) ? x : ERR.NUM;
}

function arithmetic(op: string, l: Scalar, r: Scalar): Scalar {
  const a = toNumber(l);
  if (isErr(a)) return a;
  const b = toNumber(r);
  if (isErr(b)) return b;
  switch (op) {
    case "+":
      return finite(a + b);
    case "-":
      return finite(a - b);
    case "*":
      return finite(a * b);
    case "/":
      return b === 0 ? ERR.DIV0 : finite(a / b);
    default:
      if (a === 0 && b < 0) return ERR.DIV0;
      return finite(Math.pow(a, b));
  }
}

function comparison(op: string, l: Scalar, r: Scalar): Scalar {
  if (isErr(l)) return l;
  if (isErr(r)) return r;
  const c = compareValues(l, r);
  switch (op) {
    case "=":
      return c === 0;
    case "<>":
      return c !== 0;
    case "<":
      return c < 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    default:
      return c >= 0;
  }
}

/** Évalue un nœud ; une plage donne une matrice. */
export function evaluate(node: Node, ctx: EvalContext): Arg {
  const ev = (n: Node): Arg => evaluate(n, ctx);
  switch (node.t) {
    case "num":
    case "str":
    case "bool":
      return node.v;
    case "err":
      return errFromCode(node.v);
    case "empty":
      return null;
    case "name":
      return ERR.NAME;
    case "paren":
      return ev(node.arg);
    case "ref": {
      const s = ctx.resolveSheet(node.sheet);
      return s < 0 ? ERR.REF : ctx.getCell(s, node.row, node.col);
    }
    case "range": {
      const s = ctx.resolveSheet(node.sheet);
      if (s < 0) return ERR.REF;
      const r1 = Math.min(node.a.row, node.b.row);
      const r2 = Math.max(node.a.row, node.b.row);
      const c1 = Math.min(node.a.col, node.b.col);
      const c2 = Math.max(node.a.col, node.b.col);
      return { m: ctx.getRange(s, r1, c1, r2, c2) };
    }
    case "unary": {
      const v = toScalar(ev(node.arg));
      if (node.op === "+") return v;
      const n = toNumber(v);
      return isErr(n) ? n : -n;
    }
    case "percent": {
      const n = toNumber(toScalar(ev(node.arg)));
      return isErr(n) ? n : n / 100;
    }
    case "bin": {
      const l = toScalar(ev(node.l));
      const r = toScalar(ev(node.r));
      if (node.op === "&") {
        const a = toText(l);
        if (isErr(a)) return a;
        const b = toText(r);
        return isErr(b) ? b : a + b;
      }
      if (["=", "<>", "<", ">", "<=", ">="].includes(node.op)) return comparison(node.op, l, r);
      return arithmetic(node.op, l, r);
    }
    case "call": {
      const def = FUNCTIONS[node.name] ?? FUNCTIONS[node.name.replace(/^_XLFN\./, "")];
      if (!def) return ERR.NAME;
      if (node.args.length < def.min || node.args.length > def.max) return ERR.VALUE;
      if (def.lazy) return def.lazy(node.args, ev, ctx);
      const args = node.args.map(ev);
      return def.fn ? def.fn(args, ctx) : ERR.NAME;
    }
  }
}

/** Valeur finale d'une cellule-formule (jamais de matrice ni de null). */
export function evaluateCell(node: Node, ctx: EvalContext): Scalar {
  const v = toScalar(evaluate(node, ctx));
  return v === null ? 0 : v;
}
