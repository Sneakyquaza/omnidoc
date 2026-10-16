import { execFileSync } from "node:child_process";
import {
  alertTexts,
  consoleErrors,
  openAs,
  saveWithShortcut,
  sessionFile,
  waitForEditor,
} from "../helpers";

describe("parcours texte riche : gras", () => {
  it("Mod+B, enregistrer docx, rouvrir : <strong> présent", async () => {
    const file = sessionFile();
    await waitForEditor("richText");
    const prose = await $('[data-testid="editor-richText"] .ProseMirror');
    await prose.click();
    await browser.keys(["Control", "End"]);
    await browser.keys(" ");
    await browser.keys(["Control", "b"]);
    await browser.keys("GrasUniqueE2E");
    await browser.keys(["Control", "b"]);
    await saveWithShortcut();
    await browser.waitUntil(
      () =>
        execFileSync("unzip", ["-p", file, "word/document.xml"], { encoding: "utf8" }).includes(
          "GrasUniqueE2E",
        ),
      { timeout: 10_000, timeoutMsg: "texte absent du docx" },
    );
    await openAs("binary");
    await waitForEditor("binary");
    await openAs("docx");
    await $('[data-testid="editor-richText"] .ProseMirror').waitForExist({ timeout: 10_000 });
    await browser.waitUntil(
      async () => {
        const strongs = await $$('[data-testid="editor-richText"] .ProseMirror strong');
        for (const s of strongs) if ((await s.getText()).includes("GrasUniqueE2E")) return true;
        return false;
      },
      { timeout: 10_000, timeoutMsg: "marque gras absente après réouverture" },
    );
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
