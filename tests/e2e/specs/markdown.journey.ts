import { alertTexts, consoleErrors, waitForEditor } from "../helpers";

describe("parcours markdown", () => {
  it("le bouton Aperçu affiche l'aperçu rendu", async () => {
    await waitForEditor("text");
    await $('[data-testid="text-preview-toggle"]').click();
    const preview = await $('[data-testid="markdown-preview"]');
    await preview.waitForExist({ timeout: 10_000 });
    expect(await preview.$("h1").getText()).toBe("Titre");
    expect(await preview.$("strong").getText()).toBe("gras");
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
