import { describe, expect, it } from "vitest";
import { detectIndent } from "./indent";
import { markdownOutline } from "./outline";
import { buildTree, countNodes, flattenTree, parseJsonTree } from "./tree";
import {
  formatJson,
  formatXml,
  lineCol,
  offsetOf,
  validateJson,
  validateToml,
  validateXml,
  validateYaml,
} from "./validate";

describe("validateurs", () => {
  it("JSON valide", () => {
    expect(validateJson('{"a": [1, 2, {"b": null}]}')).toEqual([]);
    expect(validateJson("")).toEqual([]);
  });

  it("JSON : position de l'erreur", () => {
    const text = '{"a": 1,\n "b": }';
    const [issue] = validateJson(text);
    expect(issue?.from).toBe(text.indexOf("}", 10));
    expect(lineCol(text, issue?.from ?? 0)).toEqual({ line: 2, column: 7 });
    expect(validateJson('{"a": 1,}')[0]?.from).toBe(8);
    expect(validateJson('{"a": 1')[0]?.key).toBe("unexpectedEnd");
  });

  it("YAML : erreur de syntaxe positionnée", () => {
    expect(validateYaml("a: 1\nb: [1, 2\n")).not.toEqual([]);
    const text = "a: 1\nb: 2\n  c: 3\n";
    const issues = validateYaml(text);
    expect(issues.length).toBeGreaterThan(0);
    expect(lineCol(text, issues[0]?.from ?? 0).line).toBeGreaterThanOrEqual(2);
    expect(validateYaml("a: 1\nb: [1, 2]\n")).toEqual([]);
  });

  it("TOML : ligne/colonne", () => {
    expect(validateToml('a = 1\nb = "x"\n')).toEqual([]);
    const text = "a = 1\nb = = 2\n";
    const [issue] = validateToml(text);
    expect(issue).toBeDefined();
    expect(issue?.from).toBeGreaterThanOrEqual(6);
    expect(lineCol(text, issue?.from ?? 0).line).toBe(2);
  });

  it("XML : mal formé / valide", () => {
    expect(validateXml("<a><b/></a>")).toEqual([]);
    const issues = validateXml("<a>\n<b></a>");
    expect(issues).toHaveLength(1);
  });

  it("offsetOf / lineCol", () => {
    const text = "ab\ncd\nef";
    expect(offsetOf(text, 2, 2)).toBe(4);
    expect(lineCol(text, 4)).toEqual({ line: 2, column: 2 });
    expect(offsetOf(text, 9, 1)).toBe(text.length);
  });
});

describe("formatage", () => {
  it("JSON indenté sur 2 espaces", () => {
    expect(formatJson('{"a":[1,2],"b":{}}')).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": {}\n}');
    expect(() => formatJson("{")).toThrow();
  });

  it("XML pretty-print", () => {
    expect(formatXml("<a><b>x</b><c/></a>")).toBe("<a>\n  <b>x</b>\n  <c/>\n</a>");
  });
});

describe("plan markdown", () => {
  it("titres ATX et Setext, hors code", () => {
    const md = "# Titre\ntexte\n## Sous ##\n```\n# pas un titre\n```\nAutre\n=====\n";
    expect(markdownOutline(md)).toEqual([
      { level: 1, title: "Titre", offset: 0 },
      { level: 2, title: "Sous", offset: 14 },
      { level: 1, title: "Autre", offset: md.indexOf("Autre") },
    ]);
  });
});

describe("arbres", () => {
  it("JSON : structure et offsets", () => {
    const text = '{"a": [10, "x"], "b": {"c": true}}';
    const root = parseJsonTree(text);
    expect(root.kind).toBe("object");
    expect(root.children.map((c) => c.label)).toEqual(["a", "b"]);
    const a = root.children[0];
    expect(a?.kind).toBe("array");
    expect(a?.offset).toBe(text.indexOf("["));
    expect(a?.children.map((c) => c.value)).toEqual(["10", "x"]);
    expect(root.children[1]?.children[0]?.value).toBe("true");
    expect(countNodes(root)).toBe(6);
  });

  it("aplatissement selon les nœuds dépliés", () => {
    const root = parseJsonTree('{"a": {"b": 1}}');
    expect(flattenTree(root, new Set()).length).toBe(1);
    expect(flattenTree(root, new Set([root.id])).length).toBe(2);
    const rows = flattenTree(root, new Set([root.id, root.children[0]!.id]));
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it("XML", () => {
    const root = buildTree("xml", '<r x="1"><a>t</a><b><c/></b></r>');
    expect(root?.label).toBe("r");
    expect(root?.children.map((c) => c.label)).toEqual(["@x", "a", "b"]);
    expect(root?.children[1]?.value).toBe("t");
  });

  it("YAML et TOML", () => {
    const y = buildTree("yaml", "a: 1\nb:\n  - x\n  - y\n");
    expect(y?.children.map((c) => c.label)).toEqual(["a", "b"]);
    expect(y?.children[1]?.children).toHaveLength(2);
    expect(y?.children[1]?.offset).toBe(5);
    const t = buildTree("toml", 'a = 1\n[s]\nb = "x"\n');
    expect(t?.children.map((c) => c.label)).toEqual(["a", "s"]);
    expect(t?.children[1]?.children[0]?.value).toBe("x");
    expect(buildTree("python", "")).toBeNull();
  });
});

describe("indentation", () => {
  it("détecte espaces et tabulations", () => {
    expect(detectIndent("a:\n    b:\n        c: 1\n    d: 2\n")).toEqual({ unit: 4 });
    expect(detectIndent("a:\n  b: 1\n  c:\n    d: 2\n")).toEqual({ unit: 2 });
    expect(detectIndent("if x:\n\ty\n\tz\n\t\tw\n")).toEqual({ unit: "tab" });
    expect(detectIndent("rien", 4)).toEqual({ unit: 4 });
  });
});
