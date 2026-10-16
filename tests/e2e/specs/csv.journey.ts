import {
  alertTexts,
  consoleErrors,
  readText,
  saveWithShortcut,
  sessionFile,
  waitForEditor,
} from "../helpers";

describe("parcours csv", () => {
  it("modifier une cellule, enregistrer, vérifier le fichier", async () => {
    const file = sessionFile();
    await waitForEditor("sheet");
    const cell = await $('[data-testid="editor-sheet"] [role="gridcell"]', { strict: false });
    await cell.waitForExist({ timeout: 10_000 });
    await cell.click();
    await browser.keys("F2");
    await browser.keys(["Control", "a"]);
    await browser.keys("Modifie");
    await browser.keys("Enter");
    await saveWithShortcut();
    await browser.waitUntil(() => readText(file).includes("Modifie"), {
      timeout: 10_000,
      timeoutMsg: `contenu disque : ${readText(file)}`,
    });
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
