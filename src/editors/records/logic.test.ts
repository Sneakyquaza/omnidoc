import { describe, expect, it } from "vitest";
import type { RecordComponent } from "../../ipc/bindings";
import {
  addDays,
  dayRange,
  decodeValue,
  encodeValue,
  formatIcsDateValue,
  formatParams,
  formatStructured,
  getTypes,
  handledIndices,
  parseBday,
  VCARD_MULTI,
  VCARD_SINGLE,
  monthGrid,
  parseIcsDateValue,
  parseParams,
  parseStructured,
  photoDataUri,
  readDateField,
  setStructuredAt,
  setText,
  setTypes,
  sortKey,
  splitUnescaped,
  writeDateField,
} from "./logic";

const comp = (props: [string, string][]): RecordComponent => ({
  name: "X",
  props: props.map(([name, value]) => ({ name, params: [], value })),
  children: [],
});

describe("valeurs texte", () => {
  it("décode les échappements", () => {
    expect(decodeValue("a\\, b\\; c\\nd\\Ne\\\\f")).toBe("a, b; c\nd\ne\\f");
    expect(decodeValue("\\\\n")).toBe("\\n");
    expect(decodeValue("\\x")).toBe("\\x");
  });
  it("encode puis décode (aller-retour)", () => {
    for (const s of [
      "",
      "simple",
      "a,b;c",
      "ligne1\nligne2",
      "back\\slash",
      "\\n littéral",
      "\r\nx",
    ]) {
      expect(decodeValue(encodeValue(s))).toBe(s.replace(/\r\n|\r/g, "\n"));
    }
    expect(encodeValue("a,b;c\nd\\")).toBe("a\\,b\\;c\\nd\\\\");
  });
});

describe("N / ADR", () => {
  it("découpe sans tenir compte des ; échappés", () => {
    expect(splitUnescaped("Doe;Jo\\;hn;;Dr.;")).toEqual(["Doe", "Jo\\;hn", "", "Dr.", ""]);
    expect(parseStructured("Doe;Jo\\;hn", 5)).toEqual(["Doe", "Jo;hn", "", "", ""]);
    expect(formatStructured(["Doe", "Jo;hn", "", "", ""])).toBe("Doe;Jo\\;hn;;;");
  });
  it("conserve la valeur brute si rien ne change", () => {
    const c = comp([["N", "Doe;John;;Mr.\\,Dr.;"]]);
    const parts = parseStructured("Doe;John;;Mr.\\,Dr.;", 5);
    expect(setStructuredAt(c, 0, parts, 5)).toBe(c);
    parts[1] = "Jane";
    expect(setStructuredAt(c, 0, parts, 5).props[0]?.value).toBe("Doe;Jane;;Mr.\\,Dr.;");
  });
  it("setText conserve le brut, crée et supprime", () => {
    const c = comp([["NOTE", "a\\, b"]]);
    expect(setText(c, "NOTE", "a, b")).toBe(c);
    expect(setText(c, "NOTE", "x;y").props[0]?.value).toBe("x\\;y");
    expect(setText(c, "NOTE", "").props).toHaveLength(0);
    expect(setText(c, "TITLE", "Chef").props[1]).toEqual({
      name: "TITLE",
      params: [],
      value: "Chef",
    });
  });
});

describe("paramètres", () => {
  it("formate et analyse", () => {
    const params = parseParams('TYPE=WORK,VOICE;PREF;X-A="a;b"');
    expect(params).toEqual([
      ["TYPE", "WORK,VOICE"],
      ["PREF", ""],
      ["X-A", '"a;b"'],
    ]);
    expect(formatParams(params)).toBe('TYPE=WORK,VOICE;PREF;X-A="a;b"');
  });
  it("types vCard", () => {
    const p = {
      name: "TEL",
      params: [
        ["WORK", ""],
        ["TYPE", "voice"],
        ["PREF", "1"],
      ] as [string, string][],
      value: "1",
    };
    expect(getTypes(p)).toBe("WORK,voice");
    expect(setTypes(p, "cell").params).toEqual([
      ["PREF", "1"],
      ["TYPE", "cell"],
    ]);
    expect(setTypes(p, "").params).toEqual([["PREF", "1"]]);
  });
});

describe("dates iCalendar", () => {
  it("analyse et formate (aller-retour)", () => {
    for (const v of ["20261015", "20261015T093000", "20261015T093000Z"]) {
      const d = parseIcsDateValue(v);
      expect(d).not.toBeNull();
      expect(formatIcsDateValue(d!)).toBe(v);
    }
    expect(parseIcsDateValue("20261015T0930")).toEqual({
      date: "2026-10-15",
      time: "09:30:00",
      utc: false,
    });
    expect(parseIcsDateValue("nope")).toBeNull();
  });
  it("conserve TZID, VALUE=DATE et UTC", () => {
    const p = {
      name: "DTSTART",
      params: [["TZID", "Europe/Paris"]] as [string, string][],
      value: "20261015T093000",
    };
    expect(readDateField(p)).toMatchObject({
      date: "2026-10-15",
      time: "09:30:00",
      allDay: false,
      tzid: "Europe/Paris",
    });
    const moved = writeDateField(p, "DTSTART", {
      date: "2026-10-16",
      time: "10:00:00",
      allDay: false,
    });
    expect(moved).toEqual({
      name: "DTSTART",
      params: [["TZID", "Europe/Paris"]],
      value: "20261016T100000",
    });
    const allDay = writeDateField(p, "DTSTART", { date: "2026-10-16", time: "", allDay: true });
    expect(allDay.params).toEqual([["VALUE", "DATE"]]);
    expect(allDay.value).toBe("20261016");
    const back = writeDateField(allDay, "DTSTART", {
      date: "2026-10-16",
      time: "08:00:00",
      allDay: false,
    });
    expect(back.params).toEqual([]);
    const utc = { name: "DTEND", params: [] as [string, string][], value: "20261015T093000Z" };
    expect(
      writeDateField(utc, "DTEND", { date: "2026-10-15", time: "10:00:00", allDay: false }).value,
    ).toBe("20261015T100000Z");
  });
  it("tri et plages", () => {
    const a = comp([["DTSTART", "20261015T093000"]]);
    const b = comp([["DTSTART", "20261014"]]);
    const c = comp([["SUMMARY", "x"]]);
    expect([a, c, b].sort((x, y) => sortKey(x).localeCompare(sortKey(y)))).toEqual([b, a, c]);
    expect(
      dayRange(
        comp([
          ["DTSTART", "20261014"],
          ["DTEND", "20261016"],
        ]),
      ),
    ).toEqual({ start: "2026-10-14", end: "2026-10-15" });
    expect(
      dayRange(
        comp([
          ["DTSTART", "20261014T100000"],
          ["DTEND", "20261014T110000"],
        ]),
      ),
    ).toEqual({ start: "2026-10-14", end: "2026-10-14" });
  });
});

describe("calendrier", () => {
  it("addDays traverse les mois", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("grille du mois (lundi en premier)", () => {
    const g = monthGrid(2026, 9); // octobre 2026 : le 1er est un jeudi
    expect(g[0]?.[0]).toBe("2026-09-28");
    expect(g[0]?.[3]).toBe("2026-10-01");
    expect(g.at(-1)?.includes("2026-10-31")).toBe(true);
    expect(g.every((w) => w.length === 7)).toBe(true);
  });
});

describe("photo", () => {
  it("accepte data URI et base64 vCard 3", () => {
    const uri = "data:image/png;base64,AAAA";
    expect(photoDataUri({ name: "PHOTO", params: [], value: uri })).toBe(uri);
    expect(
      photoDataUri({
        name: "PHOTO",
        params: [
          ["ENCODING", "b"],
          ["TYPE", "JPEG"],
        ],
        value: "AAAA",
      }),
    ).toBe("data:image/jpeg;base64,AAAA");
    expect(photoDataUri({ name: "PHOTO", params: [], value: "http://x/y.png" })).toBeNull();
    expect(
      photoDataUri({ name: "PHOTO", params: [], value: "data:text/html;base64,AA" }),
    ).toBeNull();
  });
});

describe("propriétés avancées", () => {
  it("sépare formulaire et brut", () => {
    const c: RecordComponent = {
      name: "VCARD",
      props: [
        { name: "FN", params: [], value: "A" },
        { name: "FN", params: [], value: "B" },
        { name: "X-FOO", params: [], value: "1" },
        { name: "BDAY", params: [], value: "--0517" },
        { name: "item1.TEL", params: [], value: "123" },
        { name: "NOTE", params: [["ENCODING", "QUOTED-PRINTABLE"]], value: "=C3=A9" },
      ],
      children: [],
    };
    expect([...handledIndices(c, VCARD_SINGLE, VCARD_MULTI)]).toEqual([0, 4]);
    expect(parseBday("19900517")).toBe("1990-05-17");
    expect(parseBday("--0517")).toBeNull();
  });
});
