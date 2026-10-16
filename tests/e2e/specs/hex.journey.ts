import { alertTexts, consoleErrors, waitForEditor } from "../helpers";

const selected = () =>
  browser.execute(() => {
    const cell = document.querySelector('[role="gridcell"][aria-selected="true"]');
    return cell ? Number((cell as HTMLElement).dataset.o) : null;
  });

async function submitBar(text: string): Promise<void> {
  const input = await $('[data-testid="hex-bar-input"]');
  await input.waitForExist({ timeout: 5000 });
  await input.click();
  await browser.keys(["Control", "a"]);
  await browser.keys(text);
  await browser.keys("Enter");
}

describe("parcours hexadécimal", () => {
  before(async () => {
    await waitForEditor("binary");
  });

  it("octets du début affichés, aucun bandeau « modifié »", async () => {
    const first = await $('[role="gridcell"][data-o="0"]');
    await first.waitForExist({ timeout: 10_000 });
    await browser.waitUntil(async () => (await first.getText()) === "5A", { timeout: 5000 });
    expect(await $('[role="gridcell"][data-o="5"]').getText()).toBe("FE");
    expect(
      await browser.execute(() => document.querySelectorAll('[data-testid="tab-dirty"]').length),
    ).toBe(0);
  });

  it("Ctrl+F (texte) trouve le marqueur à l'offset 0x1020", async () => {
    await $('[role="gridcell"][data-o="0"]').click();
    await browser.keys(["Control", "f"]);
    await $('[data-testid="hex-bar-input"]').waitForExist({ timeout: 5000 });
    await $("select[aria-label]").selectByAttribute("value", "text");
    await submitBar("OMNIDOC-MARK");
    await browser.waitUntil(async () => (await selected()) === 4128, {
      timeout: 10_000,
      timeoutMsg: `sélection : ${await selected()}`,
    });
    // l'octet 'O' (0x4F) est rendu à l'offset trouvé
    const cell = await $('[role="gridcell"][data-o="4128"]');
    await cell.waitForExist({ timeout: 5000 });
    expect(await cell.getText()).toBe("4F");
  });

  it("Ctrl+G saute à un offset", async () => {
    await browser.keys(["Control", "g"]);
    await submitBar("4096");
    await browser.waitUntil(async () => (await selected()) === 4096, {
      timeout: 10_000,
      timeoutMsg: `sélection : ${await selected()}`,
    });
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
