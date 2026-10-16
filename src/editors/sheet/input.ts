import type { Cell } from "../../ipc/bindings";
import { EMPTY_CELL, EMPTY_VALUE } from "./model";
import {
  dateToSerial,
  formatNumber,
  isDateFormat,
  isTextFormat,
  isTimeFormat,
  serialToParts,
} from "./numfmt";
import type { Locale } from "./numfmt";
import { parseNumericText } from "./formula/values";

/** Saisie utilisateur ↔ cellule. */

function parseLocaleNumber(raw: string, locale: Locale): number | null {
  let s = raw.trim();
  if (locale === "fr") {
    s = s.replace(/[\s\u00a0\u202f]/g, "");
    if (/^[+-]?\d+(,\d+)?([eE][+-]?\d+)?%?$/.test(s)) s = s.replace(",", ".");
  }
  return parseNumericText(s);
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 9999) return false;
  const p = serialToParts(dateToSerial(y, m, d));
  return p.y === y && p.m === m && p.d === d;
}

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const SLASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

interface Parsed {
  value: number;
  fmt: string;
}

function parseDateTime(text: string, locale: Locale): Parsed | null {
  const t = text.trim();
  let m = ISO_RE.exec(t);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validDate(y, mo, d)) return null;
    const hasTime = m[4] !== undefined;
    const hh = Number(m[4] ?? 0);
    const mi = Number(m[5] ?? 0);
    const ss = Number(m[6] ?? 0);
    if (hh > 23 || mi > 59 || ss > 59) return null;
    return {
      value: dateToSerial(y, mo, d, hh, mi, ss),
      fmt: hasTime ? "yyyy-mm-dd hh:mm:ss" : "yyyy-mm-dd",
    };
  }
  m = SLASH_RE.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    const [d, mo] = locale === "fr" ? [a, b] : [b, a];
    if (!validDate(y, mo, d)) return null;
    return {
      value: dateToSerial(y, mo, d),
      fmt: locale === "fr" ? "dd/mm/yyyy" : "mm/dd/yyyy",
    };
  }
  m = TIME_RE.exec(t);
  if (m) {
    const [hh, mi, ss] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
    if (hh > 23 || mi > 59 || ss > 59) return null;
    return {
      value: (hh * 3600 + mi * 60 + ss) / 86400,
      fmt: m[3] === undefined ? "hh:mm" : "hh:mm:ss",
    };
  }
  return null;
}

/** Format d'affichage déduit d'une formule (DATE, TODAY, NOW). */
export function inferFormulaFormat(f: string): string | null {
  const m = /^\s*(DATE|TODAY|NOW)\s*\(/i.exec(f);
  if (!m) return null;
  return (m[1] as string).toUpperCase() === "NOW" ? "yyyy-mm-dd hh:mm:ss" : "yyyy-mm-dd";
}

function numberCell(value: number, fmt: string | null): Cell {
  return { v: { type: "number", value }, f: null, fmt };
}

/** Interprète le texte saisi dans une cellule (formule, nombre, date, booléen, texte). */
export function parseCellInput(text: string, locale: Locale, prev?: Cell): Cell {
  const prevFmt = prev?.fmt ?? null;
  if (text === "") return prevFmt ? { v: EMPTY_VALUE, f: null, fmt: prevFmt } : EMPTY_CELL;
  if (text.length > 1 && text.startsWith("=")) {
    const f = text.slice(1);
    return { v: EMPTY_VALUE, f, fmt: prevFmt ?? inferFormulaFormat(f) };
  }
  const asText = (s: string): Cell => ({ v: { type: "text", value: s }, f: null, fmt: prevFmt });
  if (isTextFormat(prevFmt)) return asText(text);
  if (text.startsWith("'")) return asText(text.slice(1));
  const up = text.trim().toUpperCase();
  if (up === "TRUE" || (locale === "fr" && up === "VRAI")) {
    return { v: { type: "bool", value: true }, f: null, fmt: prevFmt };
  }
  if (up === "FALSE" || (locale === "fr" && up === "FAUX")) {
    return { v: { type: "bool", value: false }, f: null, fmt: prevFmt };
  }
  const n = parseLocaleNumber(text, locale);
  if (n !== null) {
    let fmt = prevFmt;
    if (fmt === null && text.trim().endsWith("%")) {
      const dec = /[.,](\d+)\s*%$/.exec(text.trim())?.[1]?.length ?? 0;
      fmt = dec > 0 ? `0.${"0".repeat(dec)}%` : "0%";
    }
    return numberCell(n, fmt);
  }
  const dt = parseDateTime(text, locale);
  if (dt) return numberCell(dt.value, prevFmt && isDateFormat(prevFmt) ? prevFmt : dt.fmt);
  return asText(text);
}

/** Texte présenté à l'édition d'une cellule. */
export function cellInputText(cell: Cell | undefined, locale: Locale): string {
  if (!cell) return "";
  if (cell.f) return `=${cell.f}`;
  const v = cell.v;
  switch (v.type) {
    case "empty":
      return "";
    case "number": {
      if (v.value === null) return "";
      if (isDateFormat(cell.fmt)) {
        return formatNumber(
          v.value,
          isTimeFormat(cell.fmt) && !hasDatePart(cell.fmt)
            ? "hh:mm:ss"
            : v.value % 1 !== 0
              ? "yyyy-mm-dd hh:mm:ss"
              : "yyyy-mm-dd",
          "en",
        );
      }
      const s = String(v.value);
      return locale === "fr" ? s.replace(".", ",") : s;
    }
    case "bool":
      return locale === "fr" ? (v.value ? "VRAI" : "FAUX") : v.value ? "TRUE" : "FALSE";
    case "error":
      return v.value;
    case "text": {
      const t = v.value;
      if (t.startsWith("=") || t.startsWith("'")) return `'${t}`;
      if (!isTextFormat(cell.fmt) && parseCellInput(t, locale).v.type !== "text") return `'${t}`;
      return t;
    }
  }
}

function hasDatePart(fmt: string | null): boolean {
  return /[ydD]/.test((fmt ?? "").replace(/"[^"]*"/g, ""));
}
