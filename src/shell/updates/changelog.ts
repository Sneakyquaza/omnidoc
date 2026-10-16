import changelogRaw from "../../../CHANGELOG.md?raw";
import { compareVersions, isSemver } from "./version";

export interface ChangelogSection {
  /** Texte entre crochets : « 0.1.0 » ou « Non publié ». */
  version: string;
  date: string | null;
  /** Corps Markdown de la section (sans son titre). */
  body: string;
}

export const CHANGELOG = changelogRaw;

/** Découpe un CHANGELOG « Keep a Changelog » en sections `## [version] - date`. */
export function parseChangelog(raw: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: { version: string; date: string | null; lines: string[] } | null = null;
  const flush = () => {
    if (current) {
      sections.push({
        version: current.version,
        date: current.date,
        body: current.lines.join("\n").trim(),
      });
    }
  };
  for (const line of raw.split(/\r?\n/)) {
    const m = /^##\s+\[([^\]]+)\](?:\s*-\s*(\S+))?/.exec(line);
    if (m) {
      flush();
      current = { version: m[1] ?? "", date: m[2] ?? null, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

/** Sections publiées dans l'intervalle `]from, to]`, de la plus récente à la plus ancienne. */
export function sectionsBetween(
  sections: ChangelogSection[],
  from: string,
  to: string,
): ChangelogSection[] {
  return sections
    .filter(
      (s) =>
        isSemver(s.version) &&
        compareVersions(s.version, from) > 0 &&
        compareVersions(s.version, to) <= 0,
    )
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** Markdown à afficher pour une liste de sections. */
export function sectionsToMarkdown(sections: ChangelogSection[]): string {
  return sections
    .map((s) => `## ${s.version}${s.date ? ` (${s.date})` : ""}\n\n${s.body}`)
    .join("\n\n");
}
