import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";

describe("recherche floue", () => {
  it("accepte les sous-séquences, sans casse ni accents", () => {
    expect(fuzzyScore("ens", "Enregistrer sous…")).not.toBeNull();
    expect(fuzzyScore("ENREG", "enregistrer")).not.toBeNull();
    expect(fuzzyScore("ouvrir", "Ouvrir un fichier")).not.toBeNull();
    expect(fuzzyScore("fer", "Fermer l'onglet")).not.toBeNull();
    expect(fuzzyScore("é", "ecole")).not.toBeNull();
  });

  it("rejette l'absence d'appariement", () => {
    expect(fuzzyScore("xyz", "Ouvrir")).toBeNull();
    expect(fuzzyScore("rv", "vr")).toBeNull();
  });

  it("requête vide : tout passe, ordre conservé", () => {
    expect(fuzzyFilter(["b", "a"], "", (x) => x)).toEqual(["b", "a"]);
  });

  it("classe les meilleurs appariements d'abord", () => {
    const items = ["Changer de thème", "Fermer l'onglet", "Onglet suivant"];
    expect(fuzzyFilter(items, "ongl", (x) => x)[0]).toBe("Onglet suivant");
    expect(fuzzyFilter(items, "zzz", (x) => x)).toEqual([]);
  });
});
