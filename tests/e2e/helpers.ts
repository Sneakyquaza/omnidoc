import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** Chemin du fichier passé en argv à l'application pour cette session. */
export function sessionFile(): string {
  const caps = browser.requestedCapabilities as {
    "tauri:options"?: { args?: string[] };
  };
  const file = caps["tauri:options"]?.args?.[0];
  if (!file) throw new Error("fichier de session introuvable dans les capabilities");
  return file;
}

/** Attend l'onglet puis l'éditeur monté (`editor-<kind>`). */
export async function waitForEditor(kind: string): Promise<void> {
  await $('[data-testid="tab"]').waitForExist({ timeout: 30_000 });
  const editor = await $(`[data-testid="editor-${kind}"]`);
  await editor.waitForExist({ timeout: 30_000 }).catch(async () => {
    const page = await browser.execute(() =>
      Array.from(document.querySelectorAll('[role="dialog"],[role="alert"]'))
        .map((e) => (e as HTMLElement).innerText)
        .join(" | "),
    );
    throw new Error(`éditeur ${kind} non monté ; page : ${page}`);
  });
}

export async function detectedHandler(): Promise<string> {
  const el = await $('[data-testid="status-detected"]');
  await el.waitForExist({ timeout: 10_000 });
  return (await el.getAttribute("data-handler")) ?? "";
}

/** Erreurs capturées par le hook `window.__omnidocErrors` (build VITE_E2E). */
export async function consoleErrors(): Promise<string[]> {
  return browser.execute(
    () => (window as unknown as { __omnidocErrors?: string[] }).__omnidocErrors ?? ["hook absent"],
  );
}

/** Bannières / toasts d'erreur visibles. */
export async function alertTexts(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[role="alert"]')).map((e) => e.textContent ?? ""),
  );
}

export function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** Mod+S (Ctrl+S) puis confirmation éventuelle de la perte de fidélité. */
export async function saveWithShortcut(): Promise<void> {
  await browser.keys(["Control", "s"]);
  const dialog = await $('[role="dialog"]');
  if (
    await dialog.waitForExist({ timeout: 1500, reverse: false }).then(
      () => true,
      () => false,
    )
  ) {
    const buttons = await dialog.$$("button");
    const last = buttons[buttons.length - 1];
    if (last) await last.click();
  }
}

export async function openPalette(): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  await $('[role="dialog"][aria-label]').waitForExist({ timeout: 5000 });
}

/**
 * Vérifie que l'éditeur a réellement rendu du contenu (pas seulement monté).
 * Retourne "" si OK, sinon la raison.
 */
export async function renderedProblem(kind: string): Promise<string> {
  return browser.execute((k: string) => {
    const root = document.querySelector(`[data-testid="editor-${k}"]`);
    if (!root) return "racine absente";
    const count = (sel: string) => root.querySelectorAll(sel).length;
    const hasInk = (c: HTMLCanvasElement) => {
      if (c.width === 0 || c.height === 0) return false;
      const data = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
      if (!data) return false;
      for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) return true;
      return false;
    };
    switch (k) {
      case "text":
        return count(".cm-line") > 0 && (root.textContent ?? "").trim()
          ? ""
          : "aucune ligne CodeMirror";
      case "richText":
        return (root.querySelector(".ProseMirror")?.textContent ?? "").trim()
          ? ""
          : "document vide";
      case "sheet":
      case "database":
      case "binary":
        return count('[role="gridcell"]') > 0 ? "" : "aucune cellule";
      case "archive":
        return count('[role="treeitem"], [role="gridcell"]') > 0 ? "" : "aucune entrée";
      case "image":
      case "pdf": {
        const canvases = Array.from(root.querySelectorAll("canvas"));
        return canvases.some(hasInk) ? "" : "canvas vide";
      }
      case "notebook":
        return count("pre") > 0 ? "" : "aucune cellule";
      case "ebook":
        return count("iframe") > 0 ? "" : "aucun iframe de lecture";
      case "media":
        return count("audio, video") > 0 ? "" : "aucun lecteur";
      default:
        return (root.textContent ?? "").trim() ? "" : "vide";
    }
  }, kind);
}

/** Menu « Ouvrir comme… » du shell (le premier : certains éditeurs ont un menu au même icône). */
export async function openAs(handlerId: string): Promise<void> {
  await $('[data-testid="menu-openAs"]', { strict: false }).click();
  await $(`[data-testid="menuitem-all-${handlerId}"]`).click();
}

/** Sans GStreamer, WebKitGTK ne lit ni audio ni vidéo : l'éditeur média affiche alors une erreur de lecture attendue. */
const noPlayback = spawnSync("gst-inspect-1.0", ["wavparse"]).status !== 0;

export async function unexpectedAlerts(kind: string): Promise<string[]> {
  return kind === "media" && noPlayback ? [] : alertTexts();
}

/** Appelle une commande Tauri depuis la page (même chemin que le frontend). */
export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  // execute classique n'attend pas les promesses : le résultat est déposé sur window puis relevé.
  const key = `__e2eInvoke${Math.random().toString(36).slice(2)}`;
  await browser.execute(
    (c: string, a: Record<string, unknown>, k: string) => {
      const w = window as unknown as Record<string, unknown> & {
        __TAURI_INTERNALS__: { invoke(c: string, a: unknown): Promise<unknown> };
      };
      w.__TAURI_INTERNALS__.invoke(c, a).then(
        (r) => (w[k] = { ok: r }),
        (e) => (w[k] = { err: JSON.stringify(e) }),
      );
    },
    cmd,
    args,
    key,
  );
  let res: { ok?: T; err?: string } | undefined;
  await browser.waitUntil(
    async () => {
      res = (await browser.execute(
        (k: string) => (window as unknown as Record<string, unknown>)[k],
        key,
      )) as typeof res;
      return res !== undefined && res !== null;
    },
    { timeout: 30_000, timeoutMsg: `invoke ${cmd} sans réponse` },
  );
  if (res?.err !== undefined) throw new Error(`invoke ${cmd} : ${res.err}`);
  return res?.ok as T;
}

/**
 * Le prochain dialogue natif d'ouverture / d'enregistrement renverra `result` (sans l'afficher).
 * `__TAURI_INTERNALS__.invoke` est figé : on intercepte `fetch` (protocole IPC personnalisé de Tauri).
 */
export async function mockNextDialog(result: string | string[] | null): Promise<void> {
  await browser.execute((r: unknown) => {
    const w = window as unknown as { __e2eDialogs?: unknown[] };
    if (!w.__e2eDialogs) {
      const queue: unknown[] = [];
      w.__e2eDialogs = queue;
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = decodeURIComponent(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (/plugin:dialog\|(open|save)$/.test(url) && queue.length > 0) {
          return Promise.resolve(
            new Response(JSON.stringify(queue.shift()), {
              headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
            }),
          );
        }
        return original(input, init);
      };
    }
    w.__e2eDialogs.push(r);
  }, result);
}

/** Clique le dernier bouton (confirmation) du dialogue modal affiché. */
export async function confirmDialog(): Promise<void> {
  const dialog = await $('[role="dialog"]');
  await dialog.waitForExist({ timeout: 10_000 });
  const buttons = await dialog.$$("button");
  const last = buttons[buttons.length - 1];
  if (last) await last.click();
}

/** Indicateur « Lecture seule » de la barre d'état présent ? */
export async function readOnlyFlag(): Promise<boolean> {
  return $('[data-testid="status-readonly"]').isExisting();
}

/** Capture PNG dans `E2E_SHOTS` (vérification visuelle) ; `E2E_THEME=dark|light` force le thème. */
export async function screenshot(name: string): Promise<void> {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  const theme = process.env.E2E_THEME;
  if (theme) {
    await browser.execute((th) => {
      document.documentElement.dataset.theme = th;
    }, theme);
    await browser.pause(400);
  }
  await browser.saveScreenshot(`${dir}/${name}.png`);
}
