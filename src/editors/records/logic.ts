import type { RecordComponent, RecordProp } from "../../ipc/bindings";

type Param = [string, string];

// --- Valeurs texte (échappements vCard / iCalendar) ---

/** Décode `\n` `\N` `\,` `\;` `\\` (autres séquences conservées telles quelles). */
export function decodeValue(raw: string): string {
  return raw.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** Inverse de `decodeValue`. */
export function encodeValue(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Coupe sur `sep` en ignorant les séparateurs échappés ; les parties restent brutes. */
export function splitUnescaped(raw: string, sep = ";"): string[] {
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i);
    if (c === "\\" && i + 1 < raw.length) {
      cur += c + raw.charAt(i + 1);
      i++;
    } else if (c === sep) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

/** Valeur structurée (N, ADR, ORG) en composants décodés, complétée à `min` composants. */
export function parseStructured(raw: string, min = 0): string[] {
  const parts = splitUnescaped(raw, ";").map(decodeValue);
  while (parts.length < min) parts.push("");
  return parts;
}

export function formatStructured(parts: string[]): string {
  return parts.map(encodeValue).join(";");
}

export const N_FIELDS = ["family", "given", "additional", "prefix", "suffix"] as const;
export const ADR_FIELDS = [
  "pobox",
  "extended",
  "street",
  "city",
  "region",
  "postal",
  "country",
] as const;

// --- Paramètres ---

export function getParam(prop: RecordProp, name: string): string | undefined {
  const up = name.toUpperCase();
  return prop.params.find(([k]) => k.toUpperCase() === up)?.[1];
}

export function formatParams(params: Param[]): string {
  return params.map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join(";");
}

/** Inverse de `formatParams` (les `;` entre guillemets ne séparent pas). */
export function parseParams(text: string): Param[] {
  const out: Param[] = [];
  let cur = "";
  let quoted = false;
  const flush = () => {
    if (cur.trim() !== "") {
      const eq = cur.indexOf("=");
      out.push(eq < 0 ? [cur.trim(), ""] : [cur.slice(0, eq).trim(), cur.slice(eq + 1)]);
    }
    cur = "";
  };
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) flush();
    else cur += c;
  }
  flush();
  return out;
}

/** Types d'un champ vCard : valeurs de `TYPE=` + paramètres nus (vCard 2.1), séparés par « , ». */
export function getTypes(prop: RecordProp): string {
  const types: string[] = [];
  for (const [k, v] of prop.params) {
    if (k.toUpperCase() === "TYPE") types.push(v.replace(/"/g, ""));
    else if (v === "") types.push(k);
  }
  return types.join(",");
}

export function setTypes(prop: RecordProp, types: string): RecordProp {
  const params = prop.params.filter(([k, v]) => k.toUpperCase() !== "TYPE" && v !== "");
  const t = types.trim();
  if (t !== "") params.push(["TYPE", t]);
  return { ...prop, params };
}

// --- Propriétés ---

/** Nom sans groupe (`item1.TEL` -> `TEL`), en majuscules. */
export function baseName(prop: RecordProp): string {
  const n = prop.name;
  return n.slice(n.lastIndexOf(".") + 1).toUpperCase();
}

/** Valeur non décodable par le formulaire (ex. QUOTED-PRINTABLE) : éditable seulement en brut. */
export function isEncoded(prop: RecordProp): boolean {
  const enc = getParam(prop, "ENCODING")?.toUpperCase();
  return enc === "QUOTED-PRINTABLE" || getParam(prop, "QUOTED-PRINTABLE") !== undefined;
}

export function indicesOf(comp: RecordComponent, name: string): number[] {
  const out: number[] = [];
  comp.props.forEach((p, i) => {
    if (baseName(p) === name && !isEncoded(p)) out.push(i);
  });
  return out;
}

export function updateProp(
  comp: RecordComponent,
  index: number,
  fn: (p: RecordProp) => RecordProp,
): RecordComponent {
  return { ...comp, props: comp.props.map((p, i) => (i === index ? fn(p) : p)) };
}

export function removeProp(comp: RecordComponent, index: number): RecordComponent {
  return { ...comp, props: comp.props.filter((_, i) => i !== index) };
}

export function addProp(comp: RecordComponent, prop: RecordProp): RecordComponent {
  return { ...comp, props: [...comp.props, prop] };
}

export function textOf(comp: RecordComponent, name: string, encoded = true): string {
  const i = indicesOf(comp, name)[0];
  const p = i === undefined ? undefined : comp.props[i];
  if (!p) return "";
  return encoded ? decodeValue(p.value) : p.value;
}

/**
 * Définit la valeur (décodée) d'une propriété à valeur unique. La valeur brute d'origine est
 * conservée si le texte décodé n'a pas changé ; une valeur vide supprime la propriété.
 */
export function setText(
  comp: RecordComponent,
  name: string,
  text: string,
  opts: { encoded?: boolean; keepEmpty?: boolean } = {},
): RecordComponent {
  const encoded = opts.encoded ?? true;
  const i = indicesOf(comp, name)[0];
  const p = i === undefined ? undefined : comp.props[i];
  if (i === undefined || !p) {
    return text === ""
      ? comp
      : addProp(comp, { name, params: [], value: encoded ? encodeValue(text) : text });
  }
  const current = encoded ? decodeValue(p.value) : p.value;
  if (current === text) return comp;
  if (text === "" && !opts.keepEmpty) return removeProp(comp, i);
  return updateProp(comp, i, (q) => ({ ...q, value: encoded ? encodeValue(text) : text }));
}

/** Idem `setText` pour une propriété structurée à un index donné (valeur brute inchangée si égale). */
export function setStructuredAt(
  comp: RecordComponent,
  index: number,
  parts: string[],
  min: number,
): RecordComponent {
  const p = comp.props[index];
  if (!p) return comp;
  const current = parseStructured(p.value, min);
  if (current.length === parts.length && current.every((v, k) => v === parts[k])) return comp;
  return updateProp(comp, index, (q) => ({ ...q, value: formatStructured(parts) }));
}

// --- Dates iCalendar ---

export interface IcsDate {
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM:SS` ou null (date seule). */
  time: string | null;
  utc: boolean;
}

export function parseIcsDateValue(value: string): IcsDate | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(value.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined) return { date, time: null, utc: false };
  return { date, time: `${m[4]}:${m[5]}:${m[6] ?? "00"}`, utc: m[7] !== undefined };
}

export function formatIcsDateValue(d: IcsDate): string {
  const day = d.date.replace(/-/g, "");
  if (d.time === null) return day;
  const parts = d.time.split(":");
  const hhmmss = `${(parts[0] ?? "00").padStart(2, "0")}${(parts[1] ?? "00").padStart(2, "0")}${(parts[2] ?? "00").padStart(2, "0")}`;
  return `${day}T${hhmmss}${d.utc ? "Z" : ""}`;
}

export interface DateField {
  date: string;
  /** `HH:MM:SS` (vide si journée entière). */
  time: string;
  allDay: boolean;
  utc: boolean;
  tzid: string | null;
}

export function readDateField(prop: RecordProp | undefined): DateField | null {
  if (!prop) return null;
  const d = parseIcsDateValue(prop.value);
  if (!d) return null;
  const valueDate = getParam(prop, "VALUE")?.toUpperCase() === "DATE";
  return {
    date: d.date,
    time: d.time ?? "",
    allDay: d.time === null || valueDate,
    utc: d.utc,
    tzid: getParam(prop, "TZID") ?? null,
  };
}

/** Écrit une date/heure en conservant TZID (sauf journée entière) et les autres paramètres. */
export function writeDateField(
  existing: RecordProp | undefined,
  name: string,
  f: { date: string; time: string; allDay: boolean },
): RecordProp {
  const prev = existing ? readDateField(existing) : null;
  const base: Param[] = (existing?.params ?? []).filter(
    ([k, v]) => !(k.toUpperCase() === "VALUE" && v.toUpperCase() === "DATE"),
  );
  if (f.allDay) {
    return {
      name: existing?.name ?? name,
      params: [...base.filter(([k]) => k.toUpperCase() !== "TZID"), ["VALUE", "DATE"]],
      value: formatIcsDateValue({ date: f.date, time: null, utc: false }),
    };
  }
  return {
    name: existing?.name ?? name,
    params: base,
    value: formatIcsDateValue({
      date: f.date,
      time: f.time === "" ? "00:00:00" : f.time,
      utc: prev && !prev.allDay ? prev.utc : false,
    }),
  };
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n));
  return dt.toISOString().slice(0, 10);
}

export function todayYmd(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Horodatage UTC iCalendar (`YYYYMMDDTHHMMSSZ`). */
export function icsTimestamp(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** Clé de tri chronologique (`YYYYMMDDHHMMSS`) ; les éléments sans date passent en dernier. */
export function sortKey(comp: RecordComponent): string {
  const p = comp.props.find((q) => ["DTSTART", "DUE"].includes(baseName(q)));
  const d = p ? parseIcsDateValue(p.value) : null;
  if (!d) return "99999999999999";
  return d.date.replace(/-/g, "") + (d.time ?? "00:00:00").replace(/:/g, "");
}

/** Jours (`YYYY-MM-DD`) couverts par un événement/une tâche : fin incluse. */
export function dayRange(comp: RecordComponent): { start: string; end: string } | null {
  const sp = comp.props.find((q) => baseName(q) === "DTSTART");
  const start = readDateField(sp);
  if (!start) return null;
  const ep = comp.props.find((q) => ["DTEND", "DUE"].includes(baseName(q)));
  const end = readDateField(ep);
  if (!end || end.date <= start.date) return { start: start.date, end: start.date };
  // fin exclusive pour les journées entières ou une fin à minuit pile
  const exclusive = end.allDay || end.time === "00:00:00";
  const last = exclusive ? addDays(end.date, -1) : end.date;
  return { start: start.date, end: last < start.date ? start.date : last };
}

/** Grille d'un mois, semaines commençant le lundi (dates `YYYY-MM-DD`). */
export function monthGrid(year: number, month: number): string[][] {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const start = first.toISOString().slice(0, 10);
  const last = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  const weeks: string[][] = [];
  let cursor = addDays(start, -offset);
  while (cursor <= last) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

// --- Création ---

export function newUid(): string {
  const id =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${id}@omnidoc`;
}

export function newContact(): RecordComponent {
  return {
    name: "VCARD",
    props: [
      { name: "VERSION", params: [], value: "3.0" },
      { name: "N", params: [], value: ";;;;" },
      { name: "FN", params: [], value: "" },
    ],
    children: [],
  };
}

export function newCalendarItem(
  name: "VEVENT" | "VTODO",
  date: string,
  now = new Date(),
): RecordComponent {
  return {
    name,
    props: [
      { name: "UID", params: [], value: newUid() },
      { name: "DTSTAMP", params: [], value: icsTimestamp(now) },
      { name: "SUMMARY", params: [], value: "" },
      {
        name: "DTSTART",
        params: [["VALUE", "DATE"]],
        value: formatIcsDateValue({ date, time: null, utc: false }),
      },
    ],
    children: [],
  };
}

export function newCalendar(): RecordComponent {
  return {
    name: "VCALENDAR",
    props: [
      { name: "VERSION", params: [], value: "2.0" },
      { name: "PRODID", params: [], value: "-//OmniDoc//FR" },
    ],
    children: [],
  };
}

/** Photo vCard en data URI affichable (types d'image sûrs uniquement), sinon null. */
export function photoDataUri(prop: RecordProp): string | null {
  const v = prop.value.trim();
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(v)) return v;
  const enc = getParam(prop, "ENCODING")?.toUpperCase();
  if (enc === "B" || enc === "BASE64" || getParam(prop, "B") !== undefined) {
    const type = (getTypes(prop).split(",")[0] ?? "jpeg").toLowerCase();
    const sub = type === "jpg" ? "jpeg" : type;
    if (/^(png|jpeg|gif|webp)$/.test(sub) && /^[A-Za-z0-9+/=\s]+$/.test(v)) {
      return `data:image/${sub};base64,${v.replace(/\s+/g, "")}`;
    }
  }
  return null;
}

/** Date de naissance vCard (`YYYY-MM-DD` ou `YYYYMMDD`) en `YYYY-MM-DD`, sinon null. */
export function parseBday(value: string): string | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export const VCARD_SINGLE = ["FN", "N", "ORG", "TITLE", "NOTE", "BDAY", "PHOTO"];
export const VCARD_MULTI = ["TEL", "EMAIL", "ADR", "URL"];
export const EVENT_SINGLE = [
  "SUMMARY",
  "DTSTART",
  "DTEND",
  "LOCATION",
  "DESCRIPTION",
  "RRULE",
  "STATUS",
];
export const TODO_SINGLE = [
  "SUMMARY",
  "DTSTART",
  "DUE",
  "LOCATION",
  "DESCRIPTION",
  "RRULE",
  "STATUS",
];

/** Index des propriétés prises en charge par le formulaire (les autres vont dans « Avancé »). */
export function handledIndices(
  comp: RecordComponent,
  single: string[],
  multi: string[],
): Set<number> {
  const set = new Set<number>();
  for (const name of single) {
    const i = indicesOf(comp, name)[0];
    const p = i === undefined ? undefined : comp.props[i];
    if (i === undefined || !p) continue;
    if (name === "BDAY" && parseBday(p.value) === null) continue;
    if (name === "PHOTO" && photoDataUri(p) === null) continue;
    if (["DTSTART", "DTEND", "DUE"].includes(name) && readDateField(p) === null) continue;
    set.add(i);
  }
  for (const name of multi) for (const i of indicesOf(comp, name)) set.add(i);
  return set;
}
