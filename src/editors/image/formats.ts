/** Formats d'écriture proposés par les commandes `imageSave` / `imageConvert`. */
export const SAVE_FORMATS = [
  { format: "png", extensions: ["png"], lossy: false },
  { format: "jpeg", extensions: ["jpg", "jpeg"], lossy: true },
  { format: "webp", extensions: ["webp"], lossy: true },
  { format: "bmp", extensions: ["bmp"], lossy: false },
  { format: "tiff", extensions: ["tif", "tiff"], lossy: false },
  { format: "gif", extensions: ["gif"], lossy: false },
  { format: "ico", extensions: ["ico"], lossy: false },
] as const;

export type SaveFormat = (typeof SAVE_FORMATS)[number]["format"];

export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Format d'écriture déduit de l'extension du chemin (`null` si non supporté). */
export function formatFromPath(path: string): SaveFormat | null {
  const ext = extensionOf(path);
  const found = SAVE_FORMATS.find((f) => (f.extensions as readonly string[]).includes(ext));
  return found ? found.format : null;
}

/** Format d'écriture correspondant au format du modèle (`null` pour svg ou inconnu). */
export function saveFormatOf(modelFormat: string): SaveFormat | null {
  const f = modelFormat === "jpg" ? "jpeg" : modelFormat === "tif" ? "tiff" : modelFormat;
  return SAVE_FORMATS.some((s) => s.format === f) ? (f as SaveFormat) : null;
}

export function isLossy(format: SaveFormat): boolean {
  return SAVE_FORMATS.find((s) => s.format === format)?.lossy ?? false;
}

/** MIME pour décoder le fichier d'origine dans le WebView. */
export function mimeOf(modelFormat: string): string {
  switch (modelFormat) {
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    case "bmp":
      return "image/bmp";
    default:
      return `image/${modelFormat}`;
  }
}

export function toHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${n} ${units[0]}` : `${v.toFixed(1)} ${units[u]}`;
}

/** Retire le préfixe `data:…;base64,` d'une data URI. */
export function stripDataUri(uri: string): string {
  const i = uri.indexOf(",");
  return i < 0 ? uri : uri.slice(i + 1);
}
