import { consoleErrors, screenshot } from "../helpers";

describe("écran d'accueil", () => {
  it("s'affiche sans fichier, avec les actions Nouveau et la zone de dépôt", async () => {
    await $("h1").waitForExist({ timeout: 30_000 });
    await browser.pause(800);
    await screenshot("welcome");
    expect(await $$('[data-testid="tab"]').length).toBe(0);
    expect(await $$('[data-testid="welcome-new"]').length).toBeGreaterThan(0);
    expect(await consoleErrors()).toEqual([]);
  });
});
