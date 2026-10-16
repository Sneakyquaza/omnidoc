import { describe, expect, it } from "vitest";
import { extractOutline, isSafeImageUri, renderMarkdown, sanitizeHtml } from "./logic";

const cell = (cellType: string, source: string) => ({ cellType, source, outputs: [] });

describe("notebook logic", () => {
  it("extrait le plan en ignorant le code et les blocs fencés", () => {
    const outline = extractOutline([
      cell("markdown", "# Titre\ntexte\n```\n# pas un titre\n```\n## Sous-titre ##"),
      cell("code", "# commentaire"),
      cell("markdown", "###### Fin"),
    ]);
    expect(outline).toEqual([
      { cell: 0, level: 1, text: "Titre" },
      { cell: 0, level: 2, text: "Sous-titre" },
      { cell: 2, level: 6, text: "Fin" },
    ]);
  });

  it("assainit le HTML", () => {
    const out = sanitizeHtml(
      '<p onclick="x()">a</p><script>x()</script><style>p{}</style><img src="https://evil/x.png"><img src="data:image/png;base64,AA==">',
    );
    expect(out).not.toContain("script");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("<style");
    expect(out).not.toContain("https://evil");
    expect(out).toContain("data:image/png;base64,AA==");
  });

  it("rend le markdown sans HTML brut", () => {
    const out = renderMarkdown("**gras** <script>x()</script>");
    expect(out).toContain("<strong>gras</strong>");
    expect(out).not.toContain("<script>");
  });

  it("n'accepte que les images data:", () => {
    expect(isSafeImageUri("data:image/png;base64,AA==")).toBe(true);
    expect(isSafeImageUri("data:text/html;base64,AA==")).toBe(false);
    expect(isSafeImageUri("http://x/y.png")).toBe(false);
  });
});
