import {
  alertTexts,
  consoleErrors,
  readText,
  saveWithShortcut,
  sessionFile,
  waitForEditor,
} from "../helpers";

describe("parcours recherche / remplacement", () => {
  it("Mod+H : tout remplacer puis enregistrer", async () => {
    const file = sessionFile();
    await waitForEditor("text");
    await $('[data-testid="editor-text"] .cm-content').click();
    await browser.keys(["Control", "h"]);
    const search = await $('[data-testid="editor-text"] .cm-search input[name="search"]');
    await search.waitForExist({ timeout: 10_000 });
    await search.setValue("Bonjour");
    await $('[data-testid="editor-text"] .cm-search input[name="replace"]').setValue("Salut");
    await $('[data-testid="editor-text"] .cm-search button[name="replaceAll"]').click();
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="editor-text"] .cm-content').getText()).includes("Salut le monde"),
      { timeout: 5000, timeoutMsg: "remplacement non appliqué" },
    );
    await saveWithShortcut();
    await browser.waitUntil(() => readText(file).startsWith("Salut le monde"), {
      timeout: 10_000,
      timeoutMsg: `contenu disque : ${readText(file)}`,
    });
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
