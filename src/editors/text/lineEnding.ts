import type { LineEnding } from "../../ipc/bindings";

/** Un choix est demandé à l'enregistrement : fins de ligne mixtes et texte modifié (base inconnue = modifié). */
export function needsLineEndingChoice(
  lineEnding: LineEnding,
  text: string,
  baseline: string | null,
): boolean {
  return lineEnding === "mixed" && text !== baseline;
}

/** Fin de ligne la plus fréquente du texte (LF en cas d'égalité ou d'absence de saut de ligne). */
export function dominantLineEnding(text: string): Exclude<LineEnding, "mixed"> {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const cr = (text.match(/\r/g) ?? []).length - crlf;
  if (crlf > lf && crlf > cr) return "crlf";
  if (cr > lf && cr > crlf) return "cr";
  return "lf";
}
