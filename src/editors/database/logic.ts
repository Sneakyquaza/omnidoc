import type { DbTable, DbValue } from "../../ipc/bindings";

/** Taille d'un bloc de lignes chargé à la demande. */
export const BLOCK_SIZE = 500;

/** Texte affiché pour une cellule (NULL rendu en style dédié par le composant). */
export function formatValue(v: DbValue): string {
  switch (v.type) {
    case "null":
      return "NULL";
    case "int":
    case "real":
      return v.value === null ? "NULL" : String(v.value);
    case "text":
    case "blob":
      return v.value;
  }
}

/** Nombre de lignes d'une table : « ~ » si le comptage n'est pas exact. */
export function rowCountLabel(table: Pick<DbTable, "rowCount" | "rowCountExact">): string {
  return table.rowCountExact === false ? "~" : String(table.rowCount);
}

/** Index du bloc contenant la ligne `row`. */
export function blockOf(row: number): number {
  return Math.floor(row / BLOCK_SIZE);
}
