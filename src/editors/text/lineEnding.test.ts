import { describe, expect, it } from "vitest";
import { dominantLineEnding, needsLineEndingChoice } from "./lineEnding";

describe("fins de ligne mixtes", () => {
  it("demande un choix seulement si mixte et modifié", () => {
    expect(needsLineEndingChoice("mixed", "a\nb", "a\nb")).toBe(false);
    expect(needsLineEndingChoice("mixed", "a\nbc", "a\nb")).toBe(true);
    expect(needsLineEndingChoice("lf", "a\nbc", "a\nb")).toBe(false);
  });

  it("détecte la fin de ligne dominante", () => {
    expect(dominantLineEnding("a\r\nb\r\nc\nd")).toBe("crlf");
    expect(dominantLineEnding("a\rb\rc\nd")).toBe("cr");
    expect(dominantLineEnding("a\nb\nc\r\nd")).toBe("lf");
    expect(dominantLineEnding("abc")).toBe("lf");
  });
});
