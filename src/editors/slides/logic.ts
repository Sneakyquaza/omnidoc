import type { Slide } from "../../ipc/bindings";

/** Titre = premier texte non vide de la diapositive. */
export function slideTitle(slide: Slide): string {
  return slide.texts.find((s) => s.trim() !== "") ?? "";
}

/** Puces = textes restants (hors titre), sans les vides. */
export function slideBullets(slide: Slide): string[] {
  const i = slide.texts.findIndex((s) => s.trim() !== "");
  if (i < 0) return [];
  return slide.texts.slice(i + 1).filter((s) => s.trim() !== "");
}

export function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, index));
}

export function isSafeThumbnail(uri: string | null | undefined): uri is string {
  return typeof uri === "string" && /^data:image\/(png|jpe?g|gif|webp);/i.test(uri);
}
