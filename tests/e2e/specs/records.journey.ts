import {
  alertTexts,
  consoleErrors,
  readText,
  saveWithShortcut,
  sessionFile,
  waitForEditor,
} from "../helpers";

describe("parcours contacts (vcf)", () => {
  it("modifier le nom complet, enregistrer : le fichier contient le nouveau FN", async () => {
    const file = sessionFile();
    await waitForEditor("records");
    const fn = await $('[data-testid="records-fn"]');
    await fn.waitForExist({ timeout: 10_000 });
    await fn.click();
    await browser.keys(["Control", "a"]);
    await browser.keys("Grace Hoare");
    await saveWithShortcut();
    await browser.waitUntil(() => /FN:Grace Hoare/.test(readText(file)), {
      timeout: 10_000,
      timeoutMsg: `contenu disque : ${readText(file)}`,
    });
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
