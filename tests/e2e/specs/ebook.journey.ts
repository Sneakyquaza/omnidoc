import { alertTexts, consoleErrors, waitForEditor } from "../helpers";

/** Texte du document affiché dans l'iframe de lecture. */
async function frameText(): Promise<string> {
  const frame = await $("iframe");
  await frame.waitForExist({ timeout: 10_000 });
  await browser.switchFrame(frame);
  try {
    return await browser.execute(() => document.body?.innerText ?? "");
  } finally {
    await browser.switchFrame(null);
  }
}

describe("parcours epub", () => {
  before(async () => {
    await waitForEditor("ebook");
  });

  it("le premier chapitre s'affiche, la table des matières liste les chapitres", async () => {
    await browser.waitUntil(async () => (await frameText()).includes("Texte du premier chapitre"), {
      timeout: 10_000,
      timeoutMsg: `iframe : ${await frameText()}`,
    });
    const toc = await $('[data-testid="ebook-toc"]');
    await toc.waitForExist({ timeout: 5000 });
    expect(await toc.$$("button")).toHaveLength(2);
    expect(await toc.getText()).toContain("Premier");
    expect(await toc.getText()).toContain("Second");
    expect(
      await browser.execute(() => document.querySelectorAll('[data-testid="tab-dirty"]').length),
    ).toBe(0);
  });

  it("cliquer sur le chapitre 2 affiche son contenu", async () => {
    const buttons = await $('[data-testid="ebook-toc"]').$$("button");
    await buttons[1]?.click();
    await browser.waitUntil(async () => (await frameText()).includes("Fin."), {
      timeout: 10_000,
      timeoutMsg: `iframe : ${await frameText()}`,
    });
    expect(await frameText()).not.toContain("Texte du premier chapitre");
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
