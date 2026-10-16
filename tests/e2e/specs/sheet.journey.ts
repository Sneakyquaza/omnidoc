import fs from "node:fs";
import {
  alertTexts,
  consoleErrors,
  openAs,
  saveWithShortcut,
  sessionFile,
  waitForEditor,
} from "../helpers";

const cell = (r: number, c: number) =>
  $(`[data-testid="editor-sheet"] [role="gridcell"][data-r="${r}"][data-c="${c}"]`);

const cellText = (r: number, c: number) =>
  browser.execute(
    (rr: number, cc: number) =>
      document.querySelector(
        `[data-testid="editor-sheet"] [role="gridcell"][data-r="${rr}"][data-c="${cc}"]`,
      )?.textContent ?? "",
    r,
    c,
  );

describe("parcours tableur", () => {
  before(async () => {
    await waitForEditor("sheet");
    await cell(0, 0).waitForExist({ timeout: 10_000 });
  });

  it("Mod+Z pendant la saisie annule le texte du champ, pas l'éditeur", async () => {
    await (await cell(0, 3)).click();
    await browser.keys("F2");
    await browser.keys("5");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await cellText(0, 3)) === "5", { timeout: 5000 });
    // ré-édition : Mod+Z natif de l'input, la valeur validée (5) doit rester
    await (await cell(0, 3)).click();
    await browser.keys("F2");
    await browser.keys("999");
    await browser.keys(["Control", "z"]);
    await browser.keys("Escape");
    await browser.pause(300);
    expect(await cellText(0, 3)).toBe("5");
  });

  it("=SUM(B2:B4) affiche 107 puis survit à l'enregistrement xlsx", async () => {
    const file = sessionFile();
    await (await cell(0, 4)).click();
    await browser.keys("F2");
    await browser.keys("=SUM(B2:B4)");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await cellText(0, 4)) === "107", {
      timeout: 5000,
      timeoutMsg: `valeur affichée : ${await cellText(0, 4)}`,
    });
    const before = fs.statSync(file).mtimeMs;
    await saveWithShortcut();
    await browser.waitUntil(() => fs.statSync(file).mtimeMs > before, { timeout: 10_000 });
    // rouvrir depuis le disque
    await openAs("binary");
    await waitForEditor("binary");
    await openAs("xlsx");
    await waitForEditor("sheet");
    await cell(0, 4).waitForExist({ timeout: 10_000 });
    expect(await cellText(0, 4)).toBe("107");
    await (await cell(0, 4)).click();
    const formula = await $('[data-testid="sheet-formula-input"]');
    expect(await formula.getValue()).toBe("=SUM(B2:B4)");
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
