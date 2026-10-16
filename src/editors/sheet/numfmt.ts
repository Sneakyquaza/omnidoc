import type { CellValue } from "../../ipc/bindings";

/** Formats de nombre Excel : affichage, dates, décimales. */

export type Locale = "fr" | "en";

const MONTHS: Record<Locale, string[]> = {
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  fr: [
    "janvier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "décembre",
  ],
};
const DAYS: Record<Locale, string[]> = {
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  fr: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
};

export function separators(locale: Locale): { decimal: string; thousands: string } {
  return locale === "fr" ? { decimal: ",", thousands: " " } : { decimal: ".", thousands: "," };
}

// ---------- Dates (numéros de série Excel) ----------

const EPOCH_OFFSET = 25569; // 1970-01-01 en numéro de série
const DAY_MS = 86400000;

export function dateToSerial(y: number, m: number, d: number, h = 0, mi = 0, s = 0): number {
  const days = Date.UTC(y, m - 1, d) / DAY_MS + EPOCH_OFFSET;
  return days + (h * 3600 + mi * 60 + s) / 86400;
}

export interface DateParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  weekday: number;
}

export function serialToParts(serial: number): DateParts {
  const total = Math.round(serial * 86400);
  const day = Math.floor(total / 86400);
  const sec = total - day * 86400;
  const date = new Date((day - EPOCH_OFFSET) * DAY_MS);
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    hh: Math.floor(sec / 3600),
    mm: Math.floor((sec % 3600) / 60),
    ss: sec % 60,
    weekday: date.getUTCDay(),
  };
}

// ---------- Analyse d'un code de format ----------

type FmtToken =
  | { k: "lit"; v: string }
  | { k: "num"; pattern: string }
  | { k: "pct" }
  | { k: "sci"; digits: number }
  | { k: "y" | "m" | "d" | "h" | "s" | "mn"; n: number }
  | { k: "elapsed"; unit: "h" | "m" | "s"; n: number }
  | { k: "ampm"; short: boolean }
  | { k: "general" }
  | { k: "text" };

function splitSections(fmt: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = false;
  let bracket = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i] as string;
    if (ch === "\\" && !quote) {
      cur += ch + (fmt[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') quote = !quote;
    else if (!quote && ch === "[") bracket = true;
    else if (!quote && ch === "]") bracket = false;
    if (ch === ";" && !quote && !bracket) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function tokenizeSection(sec: string): FmtToken[] {
  const out: FmtToken[] = [];
  let i = 0;
  while (i < sec.length) {
    const ch = sec[i] as string;
    const rest = sec.slice(i);
    if (ch === '"') {
      const end = sec.indexOf('"', i + 1);
      const stop = end < 0 ? sec.length : end;
      out.push({ k: "lit", v: sec.slice(i + 1, stop) });
      i = stop + 1;
      continue;
    }
    if (ch === "\\") {
      out.push({ k: "lit", v: sec[i + 1] ?? "" });
      i += 2;
      continue;
    }
    if (ch === "_") {
      out.push({ k: "lit", v: " " });
      i += 2;
      continue;
    }
    if (ch === "*") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      const end = sec.indexOf("]", i);
      const stop = end < 0 ? sec.length - 1 : end;
      const inner = sec.slice(i + 1, stop);
      const el = /^(h+|m+|s+)$/i.exec(inner);
      if (el) {
        out.push({
          k: "elapsed",
          unit: (inner[0] as string).toLowerCase() as "h" | "m" | "s",
          n: inner.length,
        });
      } else if (inner.startsWith("$")) {
        const sym = inner.slice(1).split("-")[0] ?? "";
        if (sym) out.push({ k: "lit", v: sym });
      }
      i = stop + 1;
      continue;
    }
    if (/^general/i.test(rest)) {
      out.push({ k: "general" });
      i += 7;
      continue;
    }
    if (/^am\/pm/i.test(rest)) {
      out.push({ k: "ampm", short: false });
      i += 5;
      continue;
    }
    if (/^a\/p/i.test(rest)) {
      out.push({ k: "ampm", short: true });
      i += 3;
      continue;
    }
    if (/^e[+-]/i.test(rest)) {
      let j = i + 2;
      while (sec[j] === "0") j++;
      out.push({ k: "sci", digits: j - i - 2 });
      i = j;
      continue;
    }
    if (/[yYdDhHsS]/.test(ch) || /[mM]/.test(ch)) {
      let j = i;
      while (sec[j]?.toLowerCase() === ch.toLowerCase()) j++;
      const n = j - i;
      const k = ch.toLowerCase() as "y" | "m" | "d" | "h" | "s";
      out.push({ k, n });
      i = j;
      continue;
    }
    if (ch === "@") {
      out.push({ k: "text" });
      i++;
      continue;
    }
    if (ch === "%") {
      out.push({ k: "pct" });
      i++;
      continue;
    }
    if (/[0#?.,]/.test(ch)) {
      let j = i;
      while (j < sec.length && /[0#?.,]/.test(sec[j] as string)) j++;
      const run = sec.slice(i, j);
      if (/[0#?]/.test(run)) out.push({ k: "num", pattern: run });
      else out.push({ k: "lit", v: run });
      i = j;
      continue;
    }
    out.push({ k: "lit", v: ch });
    i++;
  }
  // m = minutes si adjacent à h / s
  for (let n = 0; n < out.length; n++) {
    const tk = out[n] as FmtToken;
    if (tk.k !== "m") continue;
    let prev: FmtToken | undefined;
    for (let p = n - 1; p >= 0; p--) {
      const c = out[p] as FmtToken;
      if (c.k !== "lit") {
        prev = c;
        break;
      }
    }
    let next: FmtToken | undefined;
    for (let p = n + 1; p < out.length; p++) {
      const c = out[p] as FmtToken;
      if (c.k !== "lit") {
        next = c;
        break;
      }
    }
    if (
      prev?.k === "h" ||
      (prev?.k === "elapsed" && prev.unit === "h") ||
      next?.k === "s" ||
      (next?.k === "elapsed" && next.unit === "s")
    ) {
      out[n] = { k: "mn", n: tk.n };
    }
  }
  return out;
}

const cache = new Map<string, FmtToken[][]>();

function sectionsOf(fmt: string): FmtToken[][] {
  let s = cache.get(fmt);
  if (!s) {
    s = splitSections(fmt).map(tokenizeSection);
    cache.set(fmt, s);
  }
  return s;
}

const DATE_KINDS = new Set(["y", "m", "d", "h", "s", "mn", "elapsed", "ampm"]);

function hasDate(tokens: FmtToken[]): boolean {
  return tokens.some((t) => DATE_KINDS.has(t.k));
}

export function isGeneralFormat(fmt: string | null | undefined): boolean {
  return !fmt || /^(general|standard)$/i.test(fmt.trim());
}

export function isDateFormat(fmt: string | null | undefined): boolean {
  if (isGeneralFormat(fmt)) return false;
  return hasDate(sectionsOf(fmt as string)[0] ?? []);
}

export function isTimeFormat(fmt: string | null | undefined): boolean {
  if (isGeneralFormat(fmt)) return false;
  return (sectionsOf(fmt as string)[0] ?? []).some(
    (t) => t.k === "h" || t.k === "s" || t.k === "ampm" || t.k === "elapsed",
  );
}

export function isTextFormat(fmt: string | null | undefined): boolean {
  return fmt?.trim() === "@";
}

// ---------- Rendu ----------

function roundHalfAway(x: number, digits: number): number {
  const s = String(x);
  if (s.includes("e")) return Number(x.toFixed(Math.min(digits, 100)));
  return Number(`${Math.round(Number(`${s}e${digits}`))}e-${digits}`);
}

export function formatGeneral(n: number, locale: Locale): string {
  if (!Number.isFinite(n)) return "#NUM!";
  let s: string;
  if (Number.isInteger(n) && Math.abs(n) < 1e11) s = String(n);
  else {
    const abs = Math.abs(n);
    if (abs >= 1e11 || (abs < 1e-4 && abs > 0)) {
      s = n
        .toExponential(5)
        .replace(/\.?0+e/, "e")
        .replace("e+", "E+")
        .replace("e-", "E-");
      s = s.replace(/E([+-])(\d)$/, "E$10$2");
    } else s = String(Number(n.toPrecision(10)));
  }
  return locale === "fr" ? s.replace(".", ",") : s;
}

function groupInt(int: string, sep: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function renderNumber(abs: number, pattern: string, locale: Locale, scaleCommas: number): string {
  const { decimal, thousands } = separators(locale);
  let value = abs / Math.pow(1000, scaleCommas);
  const dot = pattern.indexOf(".");
  const intPat = (dot < 0 ? pattern : pattern.slice(0, dot)).replace(/,+$/, (m) =>
    dot < 0 ? "" : m,
  );
  const decPat = dot < 0 ? "" : pattern.slice(dot + 1).replace(/,/g, "");
  const grouping = intPat.includes(",") && /[0#?]/.test(intPat.slice(intPat.indexOf(",") + 1));
  const intDigits = intPat.replace(/,/g, "");
  const minInt = (intDigits.match(/0/g) ?? []).length;
  const decimals = decPat.length;
  const minDec = (decPat.match(/0/g) ?? []).length;
  value = roundHalfAway(value, decimals);
  const fixed = value.toFixed(decimals);
  const [i = "0", f = ""] = fixed.split(".");
  let intStr = i;
  if (intStr === "0" && minInt === 0) intStr = "";
  if (intStr.length < minInt) intStr = intStr.padStart(minInt, "0");
  if (grouping) intStr = groupInt(intStr, thousands);
  let fracStr = f;
  while (fracStr.length > minDec && fracStr.endsWith("0")) fracStr = fracStr.slice(0, -1);
  return fracStr ? `${intStr}${decimal}${fracStr}` : intStr;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function renderDate(tokens: FmtToken[], serial: number, locale: Locale): string {
  const p = serialToParts(serial);
  const ampm = tokens.some((t) => t.k === "ampm");
  let out = "";
  for (const t of tokens) {
    switch (t.k) {
      case "lit":
        out += t.v;
        break;
      case "y":
        out += t.n <= 2 ? pad2(p.y % 100) : String(p.y).padStart(4, "0");
        break;
      case "m":
        if (t.n === 1) out += String(p.m);
        else if (t.n === 2) out += pad2(p.m);
        else {
          const name = MONTHS[locale][p.m - 1] ?? "";
          out += t.n === 3 ? name.slice(0, locale === "fr" && name.length > 4 ? 4 : 3) : name;
        }
        break;
      case "d":
        if (t.n === 1) out += String(p.d);
        else if (t.n === 2) out += pad2(p.d);
        else {
          const name = DAYS[locale][p.weekday] ?? "";
          out += t.n === 3 ? name.slice(0, 3) : name;
        }
        break;
      case "h": {
        const h = ampm ? p.hh % 12 || 12 : p.hh;
        out += t.n >= 2 ? pad2(h) : String(h);
        break;
      }
      case "mn":
        out += t.n >= 2 ? pad2(p.mm) : String(p.mm);
        break;
      case "s":
        out += t.n >= 2 ? pad2(p.ss) : String(p.ss);
        break;
      case "elapsed": {
        const totalSec = Math.round(serial * 86400);
        const v =
          t.unit === "h"
            ? Math.floor(totalSec / 3600)
            : t.unit === "m"
              ? Math.floor(totalSec / 60)
              : totalSec;
        out += String(v).padStart(t.n, "0");
        break;
      }
      case "ampm":
        out += p.hh < 12 ? (t.short ? "A" : "AM") : t.short ? "P" : "PM";
        break;
      default:
        break;
    }
  }
  return out;
}

function renderNumeric(tokens: FmtToken[], n: number, locale: Locale, negPrefix: boolean): string {
  let value = Math.abs(n);
  if (tokens.some((t) => t.k === "pct")) value *= 100;
  const sci = tokens.find((t) => t.k === "sci");
  let out = negPrefix ? "-" : "";
  let numberDone = false;
  for (const t of tokens) {
    if (t.k === "lit") out += t.v;
    else if (t.k === "pct") out += "%";
    else if (t.k === "general") out += formatGeneral(value, locale);
    else if (t.k === "num") {
      if (numberDone) continue;
      numberDone = true;
      const trailing = /,+$/.exec(t.pattern)?.[0].length ?? 0;
      const hasDot = t.pattern.includes(".");
      const scale = hasDot ? 0 : trailing;
      if (sci && sci.k === "sci") {
        const exp = value === 0 ? 0 : Math.floor(Math.log10(value));
        const mant = value / Math.pow(10, exp);
        out += renderNumber(mant, t.pattern, locale, 0);
        out += `E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(sci.digits, "0")}`;
      } else out += renderNumber(value, t.pattern, locale, scale);
    }
  }
  return out;
}

/** Formate un nombre selon un code de format Excel. */
export function formatNumber(n: number, fmt: string | null | undefined, locale: Locale): string {
  if (!Number.isFinite(n)) return "#NUM!";
  if (isGeneralFormat(fmt)) return formatGeneral(n, locale);
  const sections = sectionsOf(fmt as string);
  let tokens: FmtToken[];
  let negPrefix = false;
  if (n < 0 && sections[1]) tokens = sections[1];
  else if (n === 0 && sections[2]) tokens = sections[2];
  else {
    tokens = sections[0] ?? [];
    negPrefix = n < 0;
  }
  if (tokens.some((t) => t.k === "text") && !tokens.some((t) => t.k === "num")) {
    return tokens
      .map((t) => (t.k === "lit" ? t.v : t.k === "text" ? formatGeneral(n, locale) : ""))
      .join("");
  }
  if (hasDate(tokens)) return renderDate(tokens, n, locale);
  return renderNumeric(tokens, n, locale, negPrefix);
}

/** Texte affiché d'une cellule. */
export function formatCell(v: CellValue, fmt: string | null | undefined, locale: Locale): string {
  switch (v.type) {
    case "empty":
      return "";
    case "number":
      return v.value === null ? "#NUM!" : formatNumber(v.value, fmt, locale);
    case "text":
      return v.value;
    case "bool":
      return locale === "fr" ? (v.value ? "VRAI" : "FAUX") : v.value ? "TRUE" : "FALSE";
    case "error":
      return v.value;
  }
}

// ---------- Décimales ----------

/** Ajoute (+1) ou retire (-1) une décimale au format (null/Général → "0.0"). */
export function changeDecimals(fmt: string | null | undefined, delta: 1 | -1): string | null {
  if (isGeneralFormat(fmt)) return delta > 0 ? "0.0" : null;
  const code = fmt as string;
  // Isole la première section et la dernière suite de placeholders numériques (hors guillemets)
  const sectionEnd = code.indexOf(";") < 0 ? code.length : code.indexOf(";");
  const head = code.slice(0, sectionEnd);
  const tail = code.slice(sectionEnd);
  const re = /[0#?]+(?:\.[0#?]+)?|\.[0#?]+/g;
  let last: RegExpExecArray | null = null;
  let quoted = false;
  const quoteAt: boolean[] = [];
  for (const ch of head) {
    if (ch === '"') quoted = !quoted;
    quoteAt.push(quoted);
  }
  let m: RegExpExecArray | null;
  while ((m = re.exec(head)) !== null) {
    if (!quoteAt[m.index]) last = m;
  }
  if (!last) return code;
  const [text] = last;
  const dot = text.indexOf(".");
  let next: string;
  if (delta > 0) next = dot < 0 ? `${text}.0` : `${text}0`;
  else if (dot < 0) return code;
  else {
    const dec = text.slice(dot + 1);
    next = dec.length <= 1 ? text.slice(0, dot) : `${text.slice(0, dot)}.${dec.slice(0, -1)}`;
  }
  return head.slice(0, last.index) + next + head.slice(last.index + text.length) + tail;
}
