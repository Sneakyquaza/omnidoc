import { describe, expect, it } from "vitest";
import { CHANGELOG, parseChangelog, sectionsBetween, sectionsToMarkdown } from "./changelog";
import { compareVersions, isSemver } from "./version";

const SAMPLE = `# Changelog

## [Non publié]

### Ajouté
- Truc

## [0.2.0] - 2026-11-01

### Ajouté
- B

## [0.1.1] - 2026-10-20
- A

## [0.1.0] - 2026-10-16
- Première
`;

describe("compareVersions", () => {
  it("compare numériquement", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.1")).toBeLessThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  it("une préversion précède la version finale", () => {
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
  });

  it("détecte les versions invalides", () => {
    expect(isSemver("0.1.0")).toBe(true);
    expect(isSemver("Non publié")).toBe(false);
    expect(compareVersions("abc", "1.0.0")).toBe(0);
  });
});

describe("changelog", () => {
  it("extrait les sections", () => {
    const s = parseChangelog(SAMPLE);
    expect(s.map((x) => x.version)).toEqual(["Non publié", "0.2.0", "0.1.1", "0.1.0"]);
    expect(s[1]).toMatchObject({ date: "2026-11-01" });
    expect(s[1]?.body).toContain("- B");
    expect(s[1]?.body).not.toContain("- A");
  });

  it("sélectionne les versions nouvelles, récentes d'abord", () => {
    const s = parseChangelog(SAMPLE);
    expect(sectionsBetween(s, "0.1.0", "0.2.0").map((x) => x.version)).toEqual(["0.2.0", "0.1.1"]);
    expect(sectionsBetween(s, "0.2.0", "0.2.0")).toEqual([]);
    expect(sectionsToMarkdown(sectionsBetween(s, "0.1.1", "0.2.0"))).toContain("## 0.2.0");
  });

  it("le CHANGELOG du dépôt contient la version 0.1.0", () => {
    expect(parseChangelog(CHANGELOG).some((x) => x.version === "0.1.0")).toBe(true);
  });
});
