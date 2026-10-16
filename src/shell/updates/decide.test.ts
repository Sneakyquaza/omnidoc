import { describe, expect, it } from "vitest";
import { shouldAskConsent, shouldAutoCheck, shouldShowUpdate, shouldShowWhatsNew } from "./decide";

describe("décisions de mise à jour", () => {
  it("consentement : demandé seulement si null et hors E2E", () => {
    expect(shouldAskConsent(null, false)).toBe(true);
    expect(shouldAskConsent(false, false)).toBe(false);
    expect(shouldAskConsent(true, false)).toBe(false);
    expect(shouldAskConsent(null, true)).toBe(false);
  });

  it("vérification automatique : seulement avec true et hors E2E", () => {
    expect(shouldAutoCheck(true, false)).toBe(true);
    expect(shouldAutoCheck(false, false)).toBe(false);
    expect(shouldAutoCheck(null, false)).toBe(false);
    expect(shouldAutoCheck(true, true)).toBe(false);
  });

  it("n'affiche que les versions plus récentes", () => {
    const base = { current: "0.1.0", ignored: null, auto: true };
    expect(shouldShowUpdate({ ...base, available: "0.2.0" })).toBe(true);
    expect(shouldShowUpdate({ ...base, available: "0.1.0" })).toBe(false);
    expect(shouldShowUpdate({ ...base, available: "0.0.9" })).toBe(false);
  });

  it("la version ignorée ne s'applique qu'au mode automatique", () => {
    const base = { current: "0.1.0", available: "0.2.0", ignored: "0.2.0" };
    expect(shouldShowUpdate({ ...base, auto: true })).toBe(false);
    expect(shouldShowUpdate({ ...base, auto: false })).toBe(true);
    expect(shouldShowUpdate({ ...base, available: "0.3.0", auto: true })).toBe(true);
  });

  it("nouveautés : rien au premier lancement ni sans changement de version", () => {
    expect(shouldShowWhatsNew(null, "0.2.0", false)).toBe(false);
    expect(shouldShowWhatsNew("0.2.0", "0.2.0", false)).toBe(false);
    expect(shouldShowWhatsNew("0.1.0", "0.2.0", false)).toBe(true);
    expect(shouldShowWhatsNew("0.1.0", "0.2.0", true)).toBe(false);
  });
});
