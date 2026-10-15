import { describe, expect, it } from "vitest";
import i18n, { detectLanguage } from "./index";

describe("i18n", () => {
  it("détecte fr sinon en", () => {
    expect(detectLanguage("fr-FR")).toBe("fr");
    expect(detectLanguage("de-DE")).toBe("en");
    expect(detectLanguage(undefined)).toBe("en");
  });

  it("renvoie les clés FR et EN", () => {
    expect(i18n.getFixedT("fr")("app.openFile")).toBe("Ouvrir un fichier…");
    expect(i18n.getFixedT("en")("app.openFile")).toBe("Open a file…");
    expect(i18n.getFixedT("fr")("errors.readOnly")).toBe("Format en lecture seule");
  });
});
