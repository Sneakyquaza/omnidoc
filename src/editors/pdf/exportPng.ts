import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { commands } from "../../ipc/bindings";
import { basename } from "../../shell/paths";
import { CSS_UNITS } from "./pdfjs";

/** Facteur de rendu des exports (2 × 96 dpi). */
const EXPORT_SCALE = 2 * CSS_UNITS;

async function pagePng(pdf: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: EXPORT_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  page.cleanup();
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Exporte des pages en PNG : une page → dialogue « Enregistrer sous », plusieurs → choix d'un dossier.
 * Renvoie le nombre de fichiers écrits (0 si l'utilisateur annule).
 */
export async function exportPagesPng(
  pdf: PDFDocumentProxy,
  pages: number[],
  sourcePath: string,
): Promise<number> {
  const base = stem(sourcePath);
  if (pages.length === 1) {
    const page = pages[0]!;
    const dest = await saveDialog({
      defaultPath: `${base}-p${page}.png`,
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (dest === null) return 0;
    await commands.imageSave(dest, await pagePng(pdf, page), "png", null);
    return 1;
  }
  const dir = await openDialog({ directory: true });
  if (typeof dir !== "string") return 0;
  const sep = dir.includes("\\") ? "\\" : "/";
  for (const page of pages) {
    await commands.imageSave(
      `${dir}${sep}${base}-p${page}.png`,
      await pagePng(pdf, page),
      "png",
      null,
    );
  }
  return pages.length;
}

/** `#rrggbb` → composantes 0..1. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
