import { execFileSync } from "node:child_process";
import {
  alertTexts,
  consoleErrors,
  openAs,
  saveWithShortcut,
  sessionFile,
  waitForEditor,
} from "../helpers";

function docxXml(file: string): string {
  return execFileSync("unzip", ["-p", file, "word/document.xml"], { encoding: "utf8" });
}

describe("parcours docx", () => {
  it("taper, enregistrer, rouvrir : le texte est présent", async () => {
    const file = sessionFile();
    await waitForEditor("richText");
    const prose = await $('[data-testid="editor-richText"] .ProseMirror');
    await prose.click();
    await browser.keys(["Control", "End"]);
    await browser.keys(" MotUniqueE2E");
    await saveWithShortcut();
    await browser.waitUntil(() => docxXml(file).includes("MotUniqueE2E"), {
      timeout: 10_000,
      timeoutMsg: "texte absent du docx sur disque",
    });
    // rouvrir : hexadécimal puis docx relit le fichier depuis le disque
    await openAs("binary");
    await waitForEditor("binary");
    await openAs("docx");
    await $('[data-testid="editor-richText"] .ProseMirror').waitForExist({ timeout: 10_000 });
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="editor-richText"] .ProseMirror').getText()).includes(
          "MotUniqueE2E",
        ),
      { timeout: 10_000, timeoutMsg: "texte absent après réouverture" },
    );
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
