import { alertTexts, consoleErrors, openAs, openPalette, waitForEditor } from "../helpers";

describe("parcours shell", () => {
  before(async () => {
    await waitForEditor("richText");
  });

  it("la palette s'ouvre (Mod+Shift+P) et se ferme", async () => {
    await openPalette();
    await browser.keys("Escape");
    await $('[role="dialog"][aria-label]').waitForExist({ reverse: true, timeout: 5000 });
  });

  it("Ouvrir comme… hexadécimal sur un docx", async () => {
    await openAs("binary");
    await waitForEditor("binary");
    expect(await $('[data-testid="editor-binary"]').isExisting()).toBe(true);
  });

  it("thème sombre via la palette", async () => {
    // system -> light -> dark : jusqu'à 3 bascules
    for (let i = 0; i < 3; i++) {
      const theme = await browser.execute(() => document.documentElement.dataset.theme);
      if (theme === "dark" && i > 0) break;
      await openPalette();
      await browser.keys("th");
      await browser.pause(300);
      await browser.keys("Enter");
      await browser.pause(300);
    }
    const bg = await browser.execute(() => document.documentElement.dataset.theme);
    expect(bg).toBe("dark");
  });

  it("le bouton « + » ouvre l'accueil sans fermer les onglets", async () => {
    await $('[data-testid="tab-home"]').click();
    await $('[data-testid="welcome"]').waitForExist({ timeout: 5000 });
    expect(await $$('[data-testid="tab"]').length).toBeGreaterThan(0);
    await $('[data-testid="tab"]').click();
    await $('[data-testid="welcome"]').waitForExist({ reverse: true, timeout: 5000 });
  });

  it("aucune erreur", async () => {
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
