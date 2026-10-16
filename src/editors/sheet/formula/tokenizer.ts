import { FormulaSyntaxError } from "./ast";

export type Token =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "name"; v: string }
  | { k: "qname"; v: string }
  | { k: "err"; v: string }
  | { k: "op"; v: string }
  | { k: "lp" }
  | { k: "rp" }
  | { k: "comma" };

const NUM_RE = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;
const NAME_RE = /^[A-Za-z_$À-￿][A-Za-z0-9_.$À-￿]*/;
const ERR_RE = /^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|CYCLE!)/i;

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const rest = src.slice(i);
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let text = "";
      for (;;) {
        if (j >= src.length) throw new FormulaSyntaxError("unterminated string");
        if (src[j] === ch) {
          if (src[j + 1] === ch) {
            text += ch;
            j += 2;
            continue;
          }
          break;
        }
        text += src[j];
        j++;
      }
      out.push(ch === '"' ? { k: "str", v: text } : { k: "qname", v: text });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = NUM_RE.exec(rest);
      if (m) {
        out.push({ k: "num", v: Number(m[0]) });
        i += m[0].length;
        continue;
      }
    }
    if (ch === "#") {
      const m = ERR_RE.exec(rest);
      if (!m) throw new FormulaSyntaxError("bad error literal");
      out.push({ k: "err", v: m[0].toUpperCase() });
      i += m[0].length;
      continue;
    }
    const nm = NAME_RE.exec(rest);
    if (nm) {
      out.push({ k: "name", v: nm[0] });
      i += nm[0].length;
      continue;
    }
    if (rest.startsWith("<>") || rest.startsWith("<=") || rest.startsWith(">=")) {
      out.push({ k: "op", v: rest.slice(0, 2) });
      i += 2;
      continue;
    }
    if (ch === "(") out.push({ k: "lp" });
    else if (ch === ")") out.push({ k: "rp" });
    else if (ch === ",") out.push({ k: "comma" });
    else if ("+-*/^&%=<>:!".includes(ch)) out.push({ k: "op", v: ch });
    else throw new FormulaSyntaxError(`unexpected character ${ch}`);
    i++;
  }
  return out;
}
