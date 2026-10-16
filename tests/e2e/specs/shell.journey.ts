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

  it("aucune erreur", async () => {
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
