import fs from "node:fs";
import path from "node:path";
import {
  consoleErrors,
  saveWithShortcut,
  sessionFile,
  unexpectedAlerts,
  waitForEditor,
} from "../helpers";

const bodyText = () => browser.execute(() => document.body.innerText);
const dirtyCount = () =>
  browser.execute(() => document.querySelectorAll('[data-testid="tab-dirty"]').length);

describe("parcours média", () => {
  const file = sessionFile();
  const isVideo = path.extname(file) === ".webm";

  before(async () => {
    await waitForEditor("media");
    await browser.pause(1000);
  });

  it("ouverture : lecteur présent, aucun bandeau « modifié »", async () => {
    const media = await $('[data-testid="media-element"]');
    await media.waitForExist({ timeout: 10_000 });
    expect(await media.getTagName()).toBe(isVideo ? "video" : "audio");
    expect(await $('[data-testid="media-play"]').isExisting()).toBe(true);
    expect(await dirtyCount()).toBe(0);
    expect(await consoleErrors()).toEqual([]);
  });

  if (isVideo) {
    it("vidéo : tags en lecture seule (WebM)", async () => {
      const title = await $("#media-tag-title");
      await title.waitForExist({ timeout: 10_000 });
      expect(await title.getAttribute("readonly")).not.toBeNull();
      expect(await bodyText()).toContain("video/webm");
    });
  } else {
    it("la durée du fichier (≈ 1 s) est affichée", async () => {
      await browser.waitUntil(async () => /00:01\.\d{3}/.test(await bodyText()), {
        timeout: 10_000,
        timeoutMsg: `durée absente : ${await bodyText()}`,
      });
      expect(await unexpectedAlerts("media")).toEqual([]);
    });

    it("lecture via le bouton", async () => {
      await $('[data-testid="media-play"]').click();
      // Sans moteur de lecture ou sans carte son, la lecture échoue : seul l'état compte alors.
      await browser.waitUntil(
        async () =>
          browser.execute(() => {
            const m = document.querySelector<HTMLMediaElement>('[data-testid="media-element"]');
            return !!m && (!m.paused || m.ended || m.error !== null);
          }),
        { timeout: 10_000, timeoutMsg: "la lecture ne démarre pas" },
      );
      expect(await consoleErrors()).toEqual([]);
    });

    it("modifier le titre, enregistrer : le tag est écrit sur le disque", async () => {
      const title = await $("#media-tag-title");
      await title.click();
      await browser.keys(["Control", "a"]);
      await browser.keys("Titre E2E");
      await browser.waitUntil(async () => (await dirtyCount()) === 1, {
        timeout: 5000,
        timeoutMsg: "le document n'est pas marqué modifié",
      });
      await saveWithShortcut();
      await browser.waitUntil(async () => (await dirtyCount()) === 0, {
        timeout: 10_000,
        timeoutMsg: "le document reste marqué modifié après l'enregistrement",
      });
      const bytes = fs.readFileSync(file);
      const found =
        bytes.includes(Buffer.from("Titre E2E", "latin1")) ||
        bytes.includes(Buffer.from("Titre E2E", "utf16le"));
      expect(found).toBe(true);
      expect(await consoleErrors()).toEqual([]);
    });
  }
});
