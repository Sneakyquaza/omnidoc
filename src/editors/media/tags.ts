import type { KeyValue } from "../../ipc/bindings";

/** Clés normalisées, dans l'ordre d'affichage du formulaire. */
export const NORMALIZED_KEYS = [
  "title",
  "artist",
  "album",
  "albumArtist",
  "year",
  "track",
  "trackTotal",
  "disc",
  "genre",
  "composer",
  "comment",
  "lyrics",
] as const;

export type NormalizedKey = (typeof NORMALIZED_KEYS)[number];
export type TagFields = Record<NormalizedKey, string>;

export interface SplitTags {
  fields: TagFields;
  /** Autres tags (clés brutes), éditables. */
  extra: KeyValue[];
}

const NORMALIZED = new Set<string>(NORMALIZED_KEYS);

export function emptyFields(): TagFields {
  return Object.fromEntries(NORMALIZED_KEYS.map((k) => [k, ""])) as TagFields;
}

/** Sépare les tags du modèle en champs normalisés et « autres tags ». */
export function splitTags(tags: KeyValue[]): SplitTags {
  const fields = emptyFields();
  const seen = new Set<string>();
  const extra: KeyValue[] = [];
  for (const tag of tags) {
    if (NORMALIZED.has(tag.key) && !seen.has(tag.key)) {
      fields[tag.key as NormalizedKey] = tag.value;
      seen.add(tag.key);
    } else {
      extra.push({ key: tag.key, value: tag.value });
    }
  }
  return { fields, extra };
}

/**
 * Reconstruit la liste de tags à écrire. Une valeur vide supprime le tag côté Rust :
 * les clés présentes à l'origine puis vidées ou retirées sont donc émises avec "".
 */
export function joinTags(initial: KeyValue[], fields: TagFields, extra: KeyValue[]): KeyValue[] {
  const out: KeyValue[] = [];
  for (const key of NORMALIZED_KEYS) {
    const value = fields[key].trim() === "" ? "" : fields[key];
    if (value !== "") out.push({ key, value });
  }
  for (const tag of extra) {
    const key = tag.key.trim();
    if (key !== "" && tag.value !== "") out.push({ key, value: tag.value });
  }
  const written = new Set(out.map((t) => t.key));
  for (const tag of initial) {
    if (!written.has(tag.key)) {
      out.push({ key: tag.key, value: "" });
      written.add(tag.key);
    }
  }
  return out;
}

/** Formats que lofty ne sait pas écrire : tags en lecture seule. */
export function isTagsReadOnlyMime(mime: string): boolean {
  return /webm|matroska|avi|msvideo/i.test(mime);
}

export function isVideoMime(mime: string): boolean {
  return mime.startsWith("video/");
}
