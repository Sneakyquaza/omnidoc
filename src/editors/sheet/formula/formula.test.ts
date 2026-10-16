import { describe, expect, it } from "vitest";
import type { Cell, Sheet } from "../../../ipc/bindings";
import { Engine } from "./engine";
import { parseFormula } from "./parser";
import { unparse } from "./rewrite";
import { tokenize } from "./tokenizer";

type Spec = number | string | boolean | null | undefined;

function cellOf(x: Spec): Cell {
  if (x === null || x === undefined || x === "")
    return { v: { type: "empty" }, f: null, fmt: null };
  if (typeof x === "number") return { v: { type: "number", value: x }, f: null, fmt: null };
  if (typeof x === "boolean") return { v: { type: "bool", value: x }, f: null, fmt: null };
  if (x.startsWith("=")) return { v: { type: "empty" }, f: x.slice(1), fmt: null };
  return { v: { type: "text", value: x }, f: null, fmt: null };
}

function sheet(name: string, data: Spec[][]): Sheet {
  return { name, rows: data.map((r) => r.map(cellOf)), colWidths: null };
}

function engineOf(data: Spec[][], extra: Sheet[] = []): Engine {
  const e = new Engine({
    locale: "en",
    now: () => new Date(2024, 2, 15, 12, 0, 0),
    random: () => 0.5,
  });
  e.load([sheet("Sheet1", data), ...extra]);
  return e;
}

/** Évalue une formule placée en Z1 d'un classeur contenant `data`. */
function calc(formula: string, data: Spec[][] = [], extra: Sheet[] = []): unknown {
  const rows = data.map((r) => r.slice());
  while (rows.length < 1) rows.push([]);
  const first = rows[0] as Spec[];
  while (first.length < 25) first.push(null);
  first.push(`=${formula}`);
  const e = engineOf(rows, extra);
  const v = e.getCell(0, 0, 25)?.v;
  if (!v) return undefined;
  return v.type === "empty" ? null : v.value;
}

const DATA: Spec[][] = [
  [1, "a", 10],
  [2, "b", 20],
  [3, "a", 30],
  [4, "c", 40],
  [5, "a", 50],
];

describe("tokenizer / parser", () => {
  it("tokenise nombres, chaînes, opérateurs", () => {
    expect(tokenize('1.5+"a""b"<>B2').map((t) => t.k)).toEqual(["num", "op", "str", "op", "name"]);
  });

  it("réécrit une formule à l'identique", () => {
    for (const f of [
      "SUM(A1:B2)",
      "A1+B2*(C3-1)",
      'IF(A1>2,"x","y")',
      "-A1%",
      "'Ma feuille'!$A$1",
    ]) {
      expect(unparse(parseFormula(f))).toBe(f);
    }
  });

  it("respecte la précédence d'Excel", () => {
    expect(calc("2+3*4")).toBe(14);
    expect(calc("-2^2")).toBe(4);
    expect(calc("2^3^2")).toBe(64);
    expect(calc("(2+3)*4")).toBe(20);
    expect(calc("10-4-3")).toBe(3);
  });

  it("gère % et &", () => {
    expect(calc("50%")).toBe(0.5);
    expect(calc('"a"&1+2')).toBe("a3");
    expect(calc("200*10%")).toBe(20);
  });
});

describe("opérateurs et erreurs", () => {
  it("compare", () => {
    expect(calc("1=1")).toBe(true);
    expect(calc("2<>2")).toBe(false);
    expect(calc("3>=3")).toBe(true);
    expect(calc('"abc"="ABC"')).toBe(true);
    expect(calc('"a"<"b"')).toBe(true);
  });

  it("division par zéro", () => {
    expect(calc("1/0")).toBe("#DIV/0!");
    expect(calc("MOD(1,0)")).toBe("#DIV/0!");
  });

  it("#VALUE! sur texte non numérique", () => {
    expect(calc('"abc"+1')).toBe("#VALUE!");
    expect(calc('"5"+1')).toBe(6);
  });

  it("#NAME? pour fonction ou nom inconnu", () => {
    expect(calc("FOO(1)")).toBe("#NAME?");
    expect(calc("bar+1")).toBe("#NAME?");
  });

  it("#NUM! et #N/A", () => {
    expect(calc("SQRT(-1)")).toBe("#NUM!");
    expect(calc('MATCH("zz",B1:B5,0)', DATA)).toBe("#N/A");
  });

  it("erreur de syntaxe → #VALUE!", () => {
    expect(calc("1+")).toBe("#VALUE!");
    expect(calc("(1")).toBe("#VALUE!");
  });

  it("erreur littérale et propagation", () => {
    expect(calc("#REF!+1")).toBe("#REF!");
    expect(calc("SUM(1,1/0)")).toBe("#DIV/0!");
  });

  it("mauvais nombre d'arguments", () => {
    expect(calc("ABS()")).toBe("#VALUE!");
    expect(calc("ABS(1,2)")).toBe("#VALUE!");
  });
});

describe("fonctions mathématiques et statistiques", () => {
  it("SUM / AVERAGE / MIN / MAX", () => {
    expect(calc("SUM(A1:A5)", DATA)).toBe(15);
    expect(calc("SUM(A1:A5,C1)", DATA)).toBe(25);
    expect(calc("AVERAGE(A1:A5)", DATA)).toBe(3);
    expect(calc("MIN(A1:A5)", DATA)).toBe(1);
    expect(calc("MAX(C1:C5)", DATA)).toBe(50);
    expect(calc("AVERAGE(B1:B5)", DATA)).toBe("#DIV/0!");
  });

  it("SUM ignore le texte des plages mais pas des arguments directs", () => {
    expect(calc("SUM(A1:B5)", DATA)).toBe(15);
    expect(calc('SUM("x")')).toBe("#VALUE!");
    expect(calc('SUM("3",TRUE)')).toBe(4);
  });

  it("COUNT / COUNTA / COUNTBLANK", () => {
    expect(calc("COUNT(A1:C5)", DATA)).toBe(10);
    expect(calc("COUNTA(A1:C6)", DATA)).toBe(15);
    expect(calc("COUNTBLANK(A1:C6)", DATA)).toBe(3);
  });

  it("COUNTIF / SUMIF / AVERAGEIF", () => {
    expect(calc('COUNTIF(B1:B5,"a")', DATA)).toBe(3);
    expect(calc('COUNTIF(A1:A5,">2")', DATA)).toBe(3);
    expect(calc('COUNTIF(A1:A5,"<>3")', DATA)).toBe(4);
    expect(calc('COUNTIF(B1:B5,"?")', DATA)).toBe(5);
    expect(calc('SUMIF(B1:B5,"a",C1:C5)', DATA)).toBe(90);
    expect(calc('SUMIF(A1:A5,">=3")', DATA)).toBe(12);
    expect(calc('AVERAGEIF(B1:B5,"a",C1:C5)', DATA)).toBe(30);
    expect(calc('AVERAGEIF(B1:B5,"zzz",C1:C5)', DATA)).toBe("#DIV/0!");
  });

  it("arrondis", () => {
    expect(calc("ROUND(2.5,0)")).toBe(3);
    expect(calc("ROUND(-2.5,0)")).toBe(-3);
    expect(calc("ROUND(1.005,2)")).toBe(1.01);
    expect(calc("ROUND(1234,-2)")).toBe(1200);
    expect(calc("ROUNDUP(1.21,1)")).toBe(1.3);
    expect(calc("ROUNDDOWN(-1.29,1)")).toBe(-1.2);
    expect(calc("INT(-1.5)")).toBe(-2);
  });

  it("MOD / ABS / SQRT / POWER / PRODUCT / PI", () => {
    expect(calc("MOD(-3,2)")).toBe(1);
    expect(calc("MOD(7,3)")).toBe(1);
    expect(calc("ABS(-4)")).toBe(4);
    expect(calc("SQRT(16)")).toBe(4);
    expect(calc("POWER(2,10)")).toBe(1024);
    expect(calc("PRODUCT(A1:A5)", DATA)).toBe(120);
    expect(calc("PI()")).toBeCloseTo(Math.PI);
  });

  it("MEDIAN / STDEV / VAR", () => {
    expect(calc("MEDIAN(A1:A5)", DATA)).toBe(3);
    expect(calc("MEDIAN(1,2,3,4)")).toBe(2.5);
    expect(calc("VAR(A1:A5)", DATA)).toBe(2.5);
    expect(calc("STDEV(A1:A5)", DATA)).toBeCloseTo(Math.sqrt(2.5));
    expect(calc("STDEV(1)")).toBe("#DIV/0!");
  });

  it("RAND", () => {
    expect(calc("RAND()")).toBe(0.5);
  });
});

describe("logique", () => {
  it("IF paresseux", () => {
    expect(calc('IF(A1>0,"pos","neg")', DATA)).toBe("pos");
    expect(calc("IF(FALSE,1/0,2)")).toBe(2);
    expect(calc("IF(FALSE,1)")).toBe(false);
  });

  it("IFERROR", () => {
    expect(calc('IFERROR(1/0,"oops")')).toBe("oops");
    expect(calc('IFERROR(5,"oops")')).toBe(5);
  });

  it("AND / OR / NOT / XOR", () => {
    expect(calc("AND(TRUE,1,A1>0)", DATA)).toBe(true);
    expect(calc("AND(TRUE,FALSE)")).toBe(false);
    expect(calc("OR(FALSE,0,A2>1)", DATA)).toBe(true);
    expect(calc("NOT(TRUE)")).toBe(false);
    expect(calc("XOR(TRUE,TRUE,TRUE)")).toBe(true);
    expect(calc("XOR(TRUE,TRUE)")).toBe(false);
  });

  it("IS*", () => {
    expect(calc("ISBLANK(Y9)")).toBe(true);
    expect(calc("ISBLANK(A1)", DATA)).toBe(false);
    expect(calc("ISNUMBER(A1)", DATA)).toBe(true);
    expect(calc("ISNUMBER(B1)", DATA)).toBe(false);
    expect(calc("ISTEXT(B1)", DATA)).toBe(true);
    expect(calc("ISERROR(1/0)")).toBe(true);
    expect(calc("ISERROR(1)")).toBe(false);
  });
});

describe("texte", () => {
  it("LEN / LEFT / RIGHT / MID", () => {
    expect(calc('LEN("héllo")')).toBe(5);
    expect(calc('LEFT("abcdef",2)')).toBe("ab");
    expect(calc('LEFT("abc")')).toBe("a");
    expect(calc('RIGHT("abcdef",3)')).toBe("def");
    expect(calc('MID("abcdef",2,3)')).toBe("bcd");
  });

  it("UPPER / LOWER / PROPER / TRIM", () => {
    expect(calc('UPPER("abc")')).toBe("ABC");
    expect(calc('LOWER("ABC")')).toBe("abc");
    expect(calc('PROPER("hello wORLD-foo")')).toBe("Hello World-Foo");
    expect(calc('TRIM("  a   b  ")')).toBe("a b");
  });

  it("CONCAT / CONCATENATE / TEXTJOIN", () => {
    expect(calc('CONCAT("a",1,B1:B2)', DATA)).toBe("a1ab");
    expect(calc('CONCATENATE("x","y")')).toBe("xy");
    expect(calc('TEXTJOIN("-",TRUE,B1:B3)', DATA)).toBe("a-b-a");
    expect(calc('TEXTJOIN(",",TRUE,"a","","b")')).toBe("a,b");
    expect(calc('TEXTJOIN(",",FALSE,"a","","b")')).toBe("a,,b");
  });

  it("SUBSTITUTE / FIND / SEARCH", () => {
    expect(calc('SUBSTITUTE("a-b-c","-","+")')).toBe("a+b+c");
    expect(calc('SUBSTITUTE("a-b-c","-","+",2)')).toBe("a-b+c");
    expect(calc('FIND("b","abcb")')).toBe(2);
    expect(calc('FIND("b","abcb",3)')).toBe(4);
    expect(calc('FIND("B","abc")')).toBe("#VALUE!");
    expect(calc('SEARCH("B","abc")')).toBe(2);
    expect(calc('SEARCH("c*e","abcde")')).toBe(3);
  });

  it("VALUE / TEXT", () => {
    expect(calc('VALUE("12.5")')).toBe(12.5);
    expect(calc('VALUE("abc")')).toBe("#VALUE!");
    expect(calc('TEXT(1234.567,"#,##0.00")')).toBe("1,234.57");
    expect(calc('TEXT(0.256,"0.0%")')).toBe("25.6%");
    expect(calc('TEXT(DATE(2024,3,5),"yyyy-mm-dd")')).toBe("2024-03-05");
  });
});

describe("recherche", () => {
  const TABLE: Spec[][] = [
    ["k1", 100, "x"],
    ["k2", 200, "y"],
    ["k3", 300, "z"],
  ];
  it("VLOOKUP exact et approché", () => {
    expect(calc('VLOOKUP("k2",A1:C3,2,FALSE)', TABLE)).toBe(200);
    expect(calc('VLOOKUP("k3",A1:C3,3,0)', TABLE)).toBe("z");
    expect(calc('VLOOKUP("nope",A1:C3,2,FALSE)', TABLE)).toBe("#N/A");
    expect(calc('VLOOKUP("k2",A1:C3,9,FALSE)', TABLE)).toBe("#REF!");
    expect(calc("VLOOKUP(250,B1:C3,2)", TABLE)).toBe("y");
  });

  it("HLOOKUP", () => {
    const rows: Spec[][] = [
      ["a", "b", "c"],
      [1, 2, 3],
    ];
    expect(calc('HLOOKUP("b",A1:C2,2,FALSE)', rows)).toBe(2);
  });

  it("INDEX / MATCH", () => {
    expect(calc("INDEX(A1:C3,2,2)", TABLE)).toBe(200);
    expect(calc("INDEX(B1:B3,3)", TABLE)).toBe(300);
    expect(calc("INDEX(A1:C3,9,1)", TABLE)).toBe("#REF!");
    expect(calc('MATCH("k3",A1:A3,0)', TABLE)).toBe(3);
    expect(calc("MATCH(250,B1:B3,1)", TABLE)).toBe(2);
    expect(calc("MATCH(250,B1:B3,-1)", [[300], [200], [100]])).toBe("#N/A");
    expect(calc('INDEX(B1:B3,MATCH("k2",A1:A3,0))', TABLE)).toBe(200);
  });

  it("XLOOKUP", () => {
    expect(calc('XLOOKUP("k2",A1:A3,B1:B3)', TABLE)).toBe(200);
    expect(calc('XLOOKUP("zz",A1:A3,B1:B3,"absent")', TABLE)).toBe("absent");
    expect(calc('XLOOKUP("zz",A1:A3,B1:B3)', TABLE)).toBe("#N/A");
    expect(calc('XLOOKUP(250,B1:B3,A1:A3,"",-1)', TABLE)).toBe("k2");
  });
});

describe("dates", () => {
  it("DATE / YEAR / MONTH / DAY", () => {
    expect(calc("DATE(2024,3,5)")).toBe(45356);
    expect(calc("YEAR(DATE(2024,3,5))")).toBe(2024);
    expect(calc("MONTH(DATE(2024,3,5))")).toBe(3);
    expect(calc("DAY(DATE(2024,3,5))")).toBe(5);
    expect(calc("DAY(DATE(2024,1,31)+1)")).toBe(1);
    expect(calc("MONTH(DATE(2024,14,1))")).toBe(2);
  });

  it("TODAY / NOW", () => {
    expect(calc("TODAY()")).toBe(45366);
    expect(calc("NOW()")).toBe(45366.5);
  });
});

describe("références", () => {
  it("absolues, relatives, plages inversées", () => {
    expect(calc("$A$1+A$2+$A3", DATA)).toBe(6);
    expect(calc("SUM(A5:A1)", DATA)).toBe(15);
  });

  it("colonnes entières", () => {
    expect(calc("SUM(A:A)", DATA)).toBe(15);
  });

  it("références inter-feuilles", () => {
    const s2 = sheet("Feuille2", [[5, 6]]);
    const s3 = sheet("Ma feuille", [[7, 8]]);
    expect(calc("Feuille2!A1+1", [], [s2])).toBe(6);
    expect(calc("SUM(Feuille2!A1:B1)", [], [s2])).toBe(11);
    expect(calc("'Ma feuille'!B1*2", [], [s3])).toBe(16);
    expect(calc("Inconnue!A1", [], [s2])).toBe("#REF!");
  });

  it("référence à une cellule vide = 0", () => {
    expect(calc("Y5+1")).toBe(1);
    expect(calc("Y5")).toBe(0);
  });
});

describe("recalcul incrémental", () => {
  const A = (n: number) => ({ v: { type: "number", value: n }, f: null, fmt: null }) as Cell;
  const val = (e: Engine, r: number, c: number) => {
    const v = e.getCell(0, r, c)?.v;
    return v && v.type !== "empty" ? v.value : null;
  };

  it("propage une modification", () => {
    const e = engineOf([[1, "=A1*2", "=B1+1"]]);
    expect(val(e, 0, 2)).toBe(3);
    e.setCells([{ sheet: 0, row: 0, col: 0, cell: A(10) }]);
    expect(val(e, 0, 1)).toBe(20);
    expect(val(e, 0, 2)).toBe(21);
  });

  it("propage à travers les plages et les feuilles", () => {
    const e = engineOf([[1], [2], ["=SUM(A1:A2)"]], [sheet("S2", [["=Sheet1!A3*10"]])]);
    expect(e.getCell(1, 0, 0)?.v).toEqual({ type: "number", value: 30 });
    e.setCells([{ sheet: 0, row: 1, col: 0, cell: A(5) }]);
    expect(e.getCell(1, 0, 0)?.v).toEqual({ type: "number", value: 60 });
  });

  it("grandes chaînes sans dépassement de pile", () => {
    const rows: Spec[][] = [[1]];
    for (let i = 2; i <= 5000; i++) rows.push([`=A${i - 1}+1`]);
    const e = engineOf(rows);
    expect(val(e, 4999, 0)).toBe(5000);
    e.setCells([{ sheet: 0, row: 0, col: 0, cell: A(100) }]);
    expect(val(e, 4999, 0)).toBe(5099);
  });

  it("détecte les cycles", () => {
    const e = engineOf([["=B1", "=A1"], ["=A2+1"]]);
    expect(val(e, 0, 0)).toBe("#CYCLE!");
    expect(val(e, 0, 1)).toBe("#CYCLE!");
    expect(val(e, 1, 0)).toBe("#CYCLE!");
    e.setCells([{ sheet: 0, row: 0, col: 1, cell: A(4) }]);
    expect(val(e, 0, 0)).toBe(4);
  });

  it("auto-référence", () => {
    const e = engineOf([["=SUM(A1:A3)"]]);
    expect(val(e, 0, 0)).toBe("#CYCLE!");
  });

  it("garde la valeur en cache d'une fonction inconnue à l'ouverture", () => {
    const e = new Engine({ locale: "en" });
    const s: Sheet = {
      name: "S",
      rows: [[{ v: { type: "number", value: 42 }, f: "WEIRDFN(1)", fmt: null }]],
      colWidths: null,
    };
    e.load([s], true);
    expect(e.getCell(0, 0, 0)?.v).toEqual({ type: "number", value: 42 });
    e.recalcAll();
    expect(e.getCell(0, 0, 0)?.v).toEqual({ type: "error", value: "#NAME?" });
  });
});
