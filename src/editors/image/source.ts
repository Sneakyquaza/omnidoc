import { commands } from "../../ipc/bindings";
import { readBytes } from "../../ipc/bytes";
import { mimeOf } from "./formats";

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode"));
    img.src = url;
  });
}

export interface LoadedSource {
  canvas: HTMLCanvasElement;
  /** Taille du fichier d'origine en octets. */
  fileSize: number;
}

/**
 * Charge les pixels d'un fichier image dans un canvas : octets → Blob → `<img>`
 * (le SVG passe par une URL blob `image/svg+xml`, jamais inséré dans le DOM ;
 * le TIFF, non décodé par le WebView, passe par l'aperçu PNG du backend).
 */
export async function loadSource(
  path: string,
  format: string,
  hint: { width: number; height: number },
): Promise<LoadedSource> {
  const bytes = await readBytes(path);
  let img: HTMLImageElement;
  if (format === "tiff" || format === "tif") {
    img = await loadImage(await commands.imagePreviewPng(path));
  } else {
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(format) }));
    try {
      img = await loadImage(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  let w = img.naturalWidth || hint.width;
  let h = img.naturalHeight || hint.height;
  if (format === "svg" && hint.width > 0 && hint.height > 0) {
    // Les SVG sans taille intrinsèque : on suit les dimensions du modèle.
    w = hint.width;
    h = hint.height;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas 2d indisponible");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { canvas, fileSize: bytes.byteLength };
}
