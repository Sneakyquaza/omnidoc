import { describe, expect, it } from "vitest";
import { isTagsReadOnlyMime, isVideoMime, joinTags, splitTags } from "./tags";

describe("splitTags", () => {
  it("sépare les clés normalisées et les autres", () => {
    const { fields, extra } = splitTags([
      { key: "title", value: "Titre" },
      { key: "year", value: "1999" },
      { key: "TXXX:Mood", value: "calme" },
    ]);
    expect(fields.title).toBe("Titre");
    expect(fields.year).toBe("1999");
    expect(fields.album).toBe("");
    expect(extra).toEqual([{ key: "TXXX:Mood", value: "calme" }]);
  });
  it("garde les doublons de clé normalisée dans les autres tags", () => {
    const { fields, extra } = splitTags([
      { key: "artist", value: "A" },
      { key: "artist", value: "B" },
    ]);
    expect(fields.artist).toBe("A");
    expect(extra).toEqual([{ key: "artist", value: "B" }]);
  });
});

describe("joinTags", () => {
  const initial = [
    { key: "title", value: "Titre" },
    { key: "genre", value: "Rock" },
    { key: "TXXX:Mood", value: "calme" },
  ];

  it("aller-retour sans modification", () => {
    const { fields, extra } = splitTags(initial);
    expect(joinTags(initial, fields, extra)).toEqual([
      { key: "title", value: "Titre" },
      { key: "genre", value: "Rock" },
      { key: "TXXX:Mood", value: "calme" },
    ]);
  });
  it("émet une valeur vide pour les tags vidés ou retirés", () => {
    const { fields } = splitTags(initial);
    fields.genre = "  ";
    fields.album = "Nouvel album";
    expect(joinTags(initial, fields, [])).toEqual([
      { key: "title", value: "Titre" },
      { key: "album", value: "Nouvel album" },
      { key: "genre", value: "" },
      { key: "TXXX:Mood", value: "" },
    ]);
  });
  it("ignore les autres tags sans clé", () => {
    const { fields } = splitTags([]);
    expect(joinTags([], fields, [{ key: " ", value: "x" }])).toEqual([]);
  });
});

describe("mime", () => {
  it("détecte les formats sans écriture de tags", () => {
    expect(isTagsReadOnlyMime("video/webm")).toBe(true);
    expect(isTagsReadOnlyMime("video/x-matroska")).toBe(true);
    expect(isTagsReadOnlyMime("video/x-msvideo")).toBe(true);
    expect(isTagsReadOnlyMime("audio/mpeg")).toBe(false);
    expect(isVideoMime("video/mp4")).toBe(true);
    expect(isVideoMime("audio/flac")).toBe(false);
  });
});
