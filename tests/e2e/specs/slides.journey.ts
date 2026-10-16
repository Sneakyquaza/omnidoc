import path from "node:path";
import { alertTexts, consoleErrors, sessionFile, waitForEditor } from "../helpers";

const stageText = () =>
  browser.execute(
    () => document.querySelector<HTMLElement>('[data-testid="slides-stage"]')?.innerText ?? "",
  );

describe("parcours diapositives", () => {
  const isPptx = path.extname(sessionFile()) === ".pptx";
  const [first, second] = isPptx ? ["Premier point", "Second point"] : ["Bonjour", "Item"];

  before(async () => {
    await waitForEditor("slides");
  });

  it("la première diapositive s'affiche, deux vignettes, pas de bandeau « modifié »", async () => {
    await browser.waitUntil(async () => (await stageText()).includes(first), {
      timeout: 10_000,
      timeoutMsg: `scène : ${await stageText()}`,
    });
    expect(await $('[data-testid="slides-thumbs"]').$$("button")).toHaveLength(2);
    expect(
      await browser.execute(() => document.querySelectorAll('[data-testid="tab-dirty"]').length),
    ).toBe(0);
  });

  it("flèche droite puis vignette : navigation entre les diapositives", async () => {
    await $('[data-testid="slides-stage"]').click();
    await browser.keys("ArrowRight");
    await browser.waitUntil(async () => (await stageText()).includes(second), {
      timeout: 5000,
      timeoutMsg: `scène : ${await stageText()}`,
    });
    const thumbs = await $('[data-testid="slides-thumbs"]').$$("button");
    await thumbs[0]?.click();
    await browser.waitUntil(async () => (await stageText()).includes(first), {
      timeout: 5000,
      timeoutMsg: `scène : ${await stageText()}`,
    });
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
