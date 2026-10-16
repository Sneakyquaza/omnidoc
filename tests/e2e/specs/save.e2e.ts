import fs from "node:fs";
import path from "node:path";
import { EXPECTED } from "../expected";
import {
  unexpectedAlerts,
  openAs,
  consoleErrors,
  saveWithShortcut,
  sessionFile,
  waitForEditor,
} from "../helpers";

/** Enregistrer (Ctrl+S) un document intact, dans chaque format inscriptible, puis le rouvrir. */
describe("enregistrement sans modification", () => {
  const file = sessionFile();
  const ext = path.basename(file).replace(/^save-sample\./, "");
  const [kind, handler] = EXPECTED[ext] ?? ["", ""];

  it(`${ext} : Ctrl+S écrit le fichier, qui se rouvre sans erreur`, async () => {
    await waitForEditor(kind);
    await browser.pause(1000);
    const before = fs.statSync(file);
    await saveWithShortcut();
    await browser.waitUntil(() => fs.statSync(file).mtimeMs !== before.mtimeMs, {
      timeout: 10_000,
      timeoutMsg: "fichier non réécrit",
    });
    expect(fs.statSync(file).size).toBeGreaterThan(0);
    expect(await unexpectedAlerts(kind)).toEqual([]);

    // relecture depuis le disque : hexadécimal puis retour au handler d'origine
    if (handler !== "binary") {
      await openAs("binary");
      await waitForEditor("binary");
      await openAs(handler);
      await waitForEditor(kind);
      await browser.pause(1000);
    }
    expect(await unexpectedAlerts(kind)).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
