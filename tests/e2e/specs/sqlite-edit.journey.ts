import {
  alertTexts,
  consoleErrors,
  invoke,
  saveWithShortcut,
  sessionFile,
  waitForEditor,
} from "../helpers";

interface Rows {
  rows: Array<Array<{ type: string; value?: unknown }>>;
}

const NAME_CELL =
  '[data-testid="editor-database"] [role="row"][aria-rowindex="2"] [role="gridcell"]:nth-child(3)';

function cellText(): Promise<string> {
  return browser.execute(
    (sel: string) => document.querySelector(sel)?.textContent ?? "",
    NAME_CELL,
  );
}

async function nameOfFirstRow(file: string): Promise<unknown> {
  const res = await invoke<Rows>("db_rows", { path: file, table: "people", offset: 0, limit: 10 });
  return res.rows[0]?.[1]?.value;
}

describe("parcours sqlite : édition à la souris", () => {
  it("modifier une cellule, Ctrl+S : l'original n'est modifié qu'à l'enregistrement", async () => {
    const file = sessionFile();
    await waitForEditor("database");
    await browser.waitUntil(async () => (await cellText()) === "Ada", {
      timeout: 15_000,
      timeoutMsg: "première ligne non chargée",
    });
    await $(NAME_CELL).doubleClick();
    const input = await $('[data-testid="db-cell-input"]');
    await input.waitForExist({ timeout: 5_000 });
    await browser.keys(["Control", "a"]);
    await browser.keys("Zed");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await cellText()) === "Zed", {
      timeout: 10_000,
      timeoutMsg: "cellule non mise à jour",
    });
    // Avant Enregistrer, le fichier d'origine est intact.
    expect(await nameOfFirstRow(file)).toBe("Ada");
    await saveWithShortcut();
    await browser.waitUntil(async () => (await nameOfFirstRow(file)) === "Zed", {
      timeout: 10_000,
      timeoutMsg: "modification absente du fichier",
    });
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
