import path from "node:path";
import {
  unexpectedAlerts,
  consoleErrors,
  detectedHandler,
  renderedProblem,
  sessionFile,
  waitForEditor,
} from "../helpers";
import { EXPECTED } from "../expected";

describe("ouverture d'un fichier", () => {
  const file = sessionFile();
  const base = path.basename(file).replace(/^open-sample\./, "");
  const expected = EXPECTED[base];

  it(`${base} : éditeur monté, type détecté, aucune erreur`, async () => {
    if (!expected) throw new Error(`pas d'attente pour ${base}`);
    const [kind, handler] = expected;
    await waitForEditor(kind);
    // laisse les effets asynchrones de l'éditeur (workers, décodage…) s'exécuter
    await browser.pause(1500);
    await browser.waitUntil(async () => (await renderedProblem(kind)) === "", {
      timeout: 10_000,
      timeoutMsg: `contenu non rendu : ${await renderedProblem(kind)}`,
    });
    if (process.env.E2E_SHOTS) await browser.saveScreenshot(`${process.env.E2E_SHOTS}/${base}.png`);
    expect(await detectedHandler()).toBe(handler);
    expect(
      await browser.execute(() => document.querySelectorAll('[data-testid="tab"]').length),
    ).toBe(1);
    // ouvrir sans toucher ne doit pas marquer le document modifié
    expect(
      await browser.execute(() => document.querySelectorAll('[data-testid="tab-dirty"]').length),
    ).toBe(0);
    expect(await unexpectedAlerts(kind)).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
