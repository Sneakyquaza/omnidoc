import {
  alertTexts,
  consoleErrors,
  readText,
  saveWithShortcut,
  sessionFile,
  waitForEditor,
} from "../helpers";

describe("parcours texte", () => {
  it("taper, Ctrl+S, relire le fichier", async () => {
    const file = sessionFile();
    await waitForEditor("text");
    const content = await $('[data-testid="editor-text"] .cm-content');
    await content.click();
    await browser.keys(["Control", "Home"]);
    await browser.keys("Ytest ");
    await saveWithShortcut();
    await browser.waitUntil(() => readText(file).startsWith("Ytest Bonjour"), {
      timeout: 10_000,
      timeoutMsg: `contenu disque : ${readText(file)}`,
    });
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
