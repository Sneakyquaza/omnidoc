import { alertTexts, consoleErrors, waitForEditor } from "../helpers";

const clickOutline = () =>
  browser.execute(() => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Titre",
    );
    button?.click();
    return button !== undefined;
  });

describe("parcours notebook", () => {
  it("cellule markdown, cellule de code et sortie sont rendues", async () => {
    await waitForEditor("notebook");
    const doc = await $('[data-testid="notebook-document"]');
    await doc.waitForExist({ timeout: 10_000 });
    await browser.waitUntil(async () => (await doc.getText()).includes("print(1+2)"), {
      timeout: 10_000,
      timeoutMsg: `document : ${await doc.getText()}`,
    });
    const text = await doc.getText();
    expect(text).toContain("Titre");
    expect(text).toContain("texte");
    // sortie du flux stdout
    expect(
      await browser.execute(() =>
        Array.from(document.querySelectorAll('[data-testid="notebook-document"] pre')).some(
          (p) => (p.textContent ?? "").trim() === "3",
        ),
      ),
    ).toBe(true);
  });

  it("le plan (titre markdown) est cliquable ; aucun bandeau « modifié »", async () => {
    expect(await clickOutline()).toBe(true);
    expect(
      await browser.execute(() => document.querySelectorAll('[data-testid="tab-dirty"]').length),
    ).toBe(0);
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
