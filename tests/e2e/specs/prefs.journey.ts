import { alertTexts, consoleErrors, waitForEditor } from "../helpers";

const toolbarText = () =>
  browser.execute(() => document.querySelector('[role="toolbar"]')?.textContent ?? "");

async function setLanguage(value: string): Promise<void> {
  await $('[data-testid="settings-language"]').selectByAttribute("value", value);
}

describe("parcours préférences", () => {
  it("Mod+, ouvre les préférences ; la langue EN change les libellés", async () => {
    await waitForEditor("text");
    await browser.keys(["Control", ","]);
    const select = await $('[data-testid="settings-language"]');
    await select.waitForExist({ timeout: 10_000 });
    try {
      await setLanguage("fr");
      await browser.waitUntil(async () => (await toolbarText()).includes("Enregistrer"), {
        timeout: 5000,
        timeoutMsg: `barre d'outils : ${await toolbarText()}`,
      });
      await setLanguage("en");
      await browser.waitUntil(async () => (await toolbarText()).includes("Save"), {
        timeout: 5000,
        timeoutMsg: `barre d'outils : ${await toolbarText()}`,
      });
      expect(await browser.execute(() => document.documentElement.lang)).toBe("en");
    } finally {
      await setLanguage("auto");
    }
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
