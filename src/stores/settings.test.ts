import { beforeEach, describe, expect, it } from "vitest";
import { useSettings } from "./settings";

describe("préférences", () => {
  beforeEach(() => useSettings.getState().resetShortcuts());

  it("borne la taille de l'interface", () => {
    useSettings.getState().setUiScale(300);
    expect(useSettings.getState().uiScale).toBe(130);
    useSettings.getState().setUiScale(10);
    expect(useSettings.getState().uiScale).toBe(90);
    useSettings.getState().setUiScale(100);
  });

  it("gère les surcharges de raccourcis", () => {
    useSettings.getState().setShortcut("file.save", "Mod+Alt+S");
    expect(useSettings.getState().shortcuts).toEqual({ "file.save": "Mod+Alt+S" });
    useSettings.getState().resetShortcut("file.save");
    expect(useSettings.getState().shortcuts).toEqual({});
  });
});
