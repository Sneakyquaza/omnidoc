import fs from "node:fs";
import {
  alertTexts,
  consoleErrors,
  readOnlyFlag,
  saveWithShortcut,
  sessionFile,
  waitForEditor,
} from "../helpers";

function pngSize(file: string): [number, number] {
  const b = fs.readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("parcours image", () => {
  it("pivoter de 90°, enregistrer : les dimensions sont échangées sur disque", async () => {
    const file = sessionFile();
    expect(pngSize(file)).toEqual([64, 48]);
    await waitForEditor("image");
    await browser.pause(500);
    await browser.keys(["Control", "Alt", "ArrowRight"]);
    await saveWithShortcut();
    await browser.waitUntil(() => pngSize(file)[0] === 48, {
      timeout: 10_000,
      timeoutMsg: `dimensions sur disque : ${pngSize(file)}`,
    });
    expect(pngSize(file)).toEqual([48, 64]);
    expect(await readOnlyFlag()).toBe(false);
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
