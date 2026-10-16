import { alertTexts, consoleErrors, waitForEditor } from "../helpers";

function gridsText(): Promise<string> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="editor-database"] [role="grid"]'))
      .map((g) => (g as HTMLElement).innerText)
      .join(" "),
  );
}

async function runQuery(sql: string): Promise<void> {
  const editor = await $('[data-testid="db-query-editor"]');
  await editor.click();
  await browser.keys(["Control", "a"]);
  await browser.keys(sql);
  await $('[data-testid="db-query-run"]').click();
}

describe("parcours sqlite", () => {
  before(async () => {
    await waitForEditor("database");
    await $('[data-testid="db-tab-query"]').click();
  });

  it("SELECT count(*) renvoie le nombre de lignes", async () => {
    await runQuery("SELECT count(*) AS n FROM people");
    await browser.waitUntil(async () => (await gridsText()).includes("3"), {
      timeout: 10_000,
      timeoutMsg: "résultat absent",
    });
    expect(await $('[data-testid="db-query-error"]').isExisting()).toBe(false);
  });

  it("DELETE est refusé (lecture seule)", async () => {
    await runQuery("DELETE FROM people");
    const err = await $('[data-testid="db-query-error"]');
    await err.waitForExist({ timeout: 10_000 });
    expect((await err.getText()).length).toBeGreaterThan(0);
    // les données sont intactes
    await runQuery("SELECT count(*) AS n FROM people");
    await browser.waitUntil(async () => !(await $('[data-testid="db-query-error"]').isExisting()), {
      timeout: 10_000,
    });
    expect(await gridsText()).toContain("3");
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
