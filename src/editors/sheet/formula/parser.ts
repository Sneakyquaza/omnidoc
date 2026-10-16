import { FormulaSyntaxError } from "./ast";
import type { CornerParts, Node } from "./ast";
import { MAX_ROWS, nameToCol, parseCellRef } from "./ref";
import { tokenize } from "./tokenizer";
import type { Token } from "./tokenizer";

const INFIX_BP: Record<string, number> = {
  "=": 10,
  "<>": 10,
  "<": 10,
  ">": 10,
  "<=": 10,
  ">=": 10,
  "&": 20,
  "+": 30,
  "-": 30,
  "*": 40,
  "/": 40,
  "^": 50,
};
/** Le moins unaire lie plus fort que ^ (comme Excel : -2^2 = 4). */
const PREFIX_BP = 60;

class Parser {
  private pos = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(offset = 0): Token | undefined {
    return this.toks[this.pos + offset];
  }

  parseAll(): Node {
    const node = this.expr(0);
    if (this.pos < this.toks.length) throw new FormulaSyntaxError("trailing tokens");
    return node;
  }

  private expr(minBp: number): Node {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      if (t?.k !== "op") break;
      if (t.v === "%") {
        this.pos++;
        left = { t: "percent", arg: left };
        continue;
      }
      const bp = INFIX_BP[t.v];
      if (bp === undefined || bp < minBp) break;
      this.pos++;
      const right = this.expr(bp + 1);
      left = { t: "bin", op: t.v, l: left, r: right };
    }
    return left;
  }

  private prefix(): Node {
    const t = this.peek();
    if (!t) throw new FormulaSyntaxError("unexpected end");
    if (t.k === "op" && (t.v === "-" || t.v === "+")) {
      this.pos++;
      return { t: "unary", op: t.v, arg: this.expr(PREFIX_BP) };
    }
    this.pos++;
    switch (t.k) {
      case "num":
        return { t: "num", v: t.v };
      case "str":
        return { t: "str", v: t.v };
      case "err":
        return { t: "err", v: t.v };
      case "lp": {
        const inner = this.expr(0);
        if (this.peek()?.k !== "rp") throw new FormulaSyntaxError("expected )");
        this.pos++;
        return { t: "paren", arg: inner };
      }
      case "name":
      case "qname":
        return this.nameLike(t);
      default:
        throw new FormulaSyntaxError("unexpected token");
    }
  }

  private nameLike(t: Extract<Token, { k: "name" | "qname" }>): Node {
    const next = this.peek();
    if (next?.k === "op" && next.v === "!") {
      this.pos++;
      return this.refAfterSheet(t.v);
    }
    if (t.k === "qname") throw new FormulaSyntaxError("quoted name without sheet reference");
    if (next?.k === "lp") {
      this.pos++;
      return { t: "call", name: t.v.toUpperCase(), args: this.args() };
    }
    const up = t.v.toUpperCase();
    if (up === "TRUE") return { t: "bool", v: true };
    if (up === "FALSE") return { t: "bool", v: false };
    const ref = parseCellRef(t.v);
    if (ref) return this.maybeRange(null, ref);
    const whole = this.wholeColumns(null, t.v);
    if (whole) return whole;
    return { t: "name", name: t.v };
  }

  /** Colonnes entières « A:C » (suite de lignes complète). */
  private wholeColumns(sheet: string | null, first: string): Node | null {
    const colon = this.peek();
    const second = this.peek(1);
    if (colon?.k !== "op" || colon.v !== ":" || second?.k !== "name") return null;
    const a = nameToCol(first.replace("$", ""));
    const b = nameToCol(second.v.replace("$", ""));
    if (a < 0 || b < 0) return null;
    this.pos += 2;
    return {
      t: "range",
      sheet,
      a: { row: 0, col: a, absRow: true, absCol: first.startsWith("$") },
      b: { row: MAX_ROWS - 1, col: b, absRow: true, absCol: second.v.startsWith("$") },
    };
  }

  private refAfterSheet(sheet: string): Node {
    const t = this.peek();
    if (t?.k !== "name") throw new FormulaSyntaxError("expected reference after !");
    this.pos++;
    const ref = parseCellRef(t.v);
    if (!ref) {
      const whole = this.wholeColumns(sheet, t.v);
      if (whole) return whole;
      throw new FormulaSyntaxError("invalid reference");
    }
    return this.maybeRange(sheet, ref);
  }

  private maybeRange(sheet: string | null, a: CornerParts): Node {
    const colon = this.peek();
    if (colon?.k === "op" && colon.v === ":") {
      this.pos++;
      let t = this.peek();
      // « Feuille!A1:Feuille!B2 » : le second préfixe est ignoré
      const bang = this.peek(1);
      if ((t?.k === "name" || t?.k === "qname") && bang?.k === "op" && bang.v === "!") {
        this.pos += 2;
        t = this.peek();
      }
      if (t?.k !== "name") throw new FormulaSyntaxError("expected reference after :");
      this.pos++;
      const b = parseCellRef(t.v);
      if (!b) throw new FormulaSyntaxError("invalid range end");
      return { t: "range", sheet, a, b };
    }
    return { t: "ref", sheet, ...a };
  }

  private args(): Node[] {
    const out: Node[] = [];
    if (this.peek()?.k === "rp") {
      this.pos++;
      return out;
    }
    for (;;) {
      const t = this.peek();
      if (t?.k === "comma" || t?.k === "rp") out.push({ t: "empty" });
      else out.push(this.expr(0));
      const sep = this.peek();
      if (sep?.k === "comma") {
        this.pos++;
        continue;
      }
      if (sep?.k === "rp") {
        this.pos++;
        return out;
      }
      throw new FormulaSyntaxError("expected , or )");
    }
  }
}

/** Analyse une formule (sans le « = » initial). Lève `FormulaSyntaxError`. */
export function parseFormula(src: string): Node {
  return new Parser(tokenize(src)).parseAll();
}
