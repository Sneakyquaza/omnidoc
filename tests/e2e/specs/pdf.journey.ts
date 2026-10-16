import {
  alertTexts,
  confirmDialog,
  consoleErrors,
  invoke,
  readOnlyFlag,
  saveWithShortcut,
  sessionFile,
  waitForEditor,
} from "../helpers";

async function pageCount(file: string): Promise<number> {
  const doc = await invoke<{ model: { pageCount: number } }>("open_document", {
    path: file,
    forcedHandler: null,
  });
  return doc.model.pageCount;
}

describe("parcours pdf", () => {
  before(async () => {
    await waitForEditor("pdf");
    await $('[data-testid="editor-pdf"] canvas', { strict: false }).waitForExist({
      timeout: 20_000,
    });
  });

  it("l'éditeur n'est pas marqué en lecture seule", async () => {
    expect(await readOnlyFlag()).toBe(false);
  });

  it("supprimer une page via le menu Pages", async () => {
    const file = sessionFile();
    expect(await pageCount(file)).toBe(3);
    await $('[data-testid="menu-file"]').click();
    await $('[data-testid="menuitem-del"]').click();
    await confirmDialog();
    await browser.waitUntil(async () => (await pageCount(file)) === 2, {
      timeout: 20_000,
      timeoutMsg: "page non supprimée",
    });
  });

  it("ajouter une note puis Mod+S : l'annotation est écrite", async () => {
    const file = sessionFile();
    expect(await invoke<unknown[]>("pdf_list_annotations", { path: file })).toHaveLength(0);
    await $('[data-testid="pdf-tool-note"]').click();
    await (await $('[data-testid="editor-pdf"] [data-page="1"] svg')).click();
    const dialog = await $('[role="dialog"]');
    await dialog.waitForExist({ timeout: 10_000 });
    await dialog.$("textarea, input").setValue("Note E2E");
    await confirmDialog();
    await $('[role="dialog"]').waitForExist({ reverse: true, timeout: 5000 });
    await saveWithShortcut();
    await browser.waitUntil(
      async () => (await invoke<unknown[]>("pdf_list_annotations", { path: file })).length === 1,
      { timeout: 20_000, timeoutMsg: "annotation absente du fichier" },
    );
    expect(await alertTexts()).toEqual([]);
    expect(await consoleErrors()).toEqual([]);
  });
});
