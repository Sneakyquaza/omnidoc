import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { alertTexts, consoleErrors, mockNextDialog, readOnlyFlag, waitForEditor } from "../helpers";

describe("parcours archive", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omnidoc-e2e-arch-"));

  before(async () => {
    await waitForEditor("archive");
    await $('[data-testid="archive-extract"]').waitForExist({ timeout: 10_000 });
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("l'éditeur n'est pas marqué en lecture seule ; Mod+S est sans effet", async () => {
    expect(await readOnlyFlag()).toBe(false);
    await browser.keys(["Control", "s"]);
    await browser.pause(500);
    expect(await alertTexts()).toEqual([]);
  });

  it("extraire tout vers un dossier", async () => {
    const dest = path.join(tmp, "out");
    fs.mkdirSync(dest);
    await mockNextDialog(dest);
    await $('[data-testid="archive-extract"]').click();
    await browser.waitUntil(() => fs.existsSync(path.join(dest, "dossier", "b.txt")), {
      timeout: 15_000,
      timeoutMsg: "fichiers non extraits",
    });
    expect(fs.readFileSync(path.join(dest, "a.txt"), "utf8")).toBe("alpha");
  });

  it("ajouter un fichier : l'entrée est listée", async () => {
    const extra = path.join(tmp, "ajout-e2e.txt");
    fs.writeFileSync(extra, "nouveau");
    await mockNextDialog([extra]);
    await $('[data-testid="archive-add-files"]').click();
    await browser.waitUntil(
      async () =>
        (
          await browser.execute(
            () => document.querySelector('[data-testid="editor-archive"]')?.textContent ?? "",
          )
        ).includes("ajout-e2e.txt"),
      { timeout: 15_000, timeoutMsg: "entrée absente" },
    );
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
