import type { DbColumnDef, DbInput, DbTable, DbValue } from "../../ipc/bindings";

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

/** Types proposés pour une colonne ; toute autre saisie est acceptée telle quelle. */
export const COLUMN_TYPES = ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"] as const;

/** Affinité SQLite d'un type déclaré (règles de la doc : INT, CHAR/CLOB/TEXT, BLOB, REAL…). */
export function affinity(type: string): "integer" | "text" | "blob" | "real" | "numeric" {
  const t = type.toUpperCase();
  if (t.includes("INT")) return "integer";
  if (/CHAR|CLOB|TEXT/.test(t)) return "text";
  if (t.trim() === "" || t.includes("BLOB")) return "blob";
  if (/REAL|FLOA|DOUB/.test(t)) return "real";
  return "numeric";
}

/**
 * Valeur à envoyer pour un texte saisi : le texte tel quel (l'affinité de la colonne convertit),
 * sauf un champ vide dans une colonne numérique, qui devient NULL.
 */
export function inputFor(text: string, colType: string): DbInput {
  if (text === "") {
    const a = affinity(colType);
    if (a === "integer" || a === "real" || a === "numeric") return { type: "null" };
  }
  return { type: "text", value: text };
}

/** Texte proposé à l'édition d'une cellule (NULL = champ vide). */
export function editText(v: DbValue | undefined): string {
  return !v || v.type === "null" ? "" : formatValue(v);
}

/** Les blobs s'affichent sous forme d'aperçu : non éditables. */
export function isEditableValue(v: DbValue | undefined): boolean {
  return v !== undefined && v.type !== "blob";
}

export interface CellPos {
  row: number;
  col: number;
}

/** Déplacement clavier d'une cellule active (bornes incluses, Home/End = début/fin de ligne). */
export function moveCell(pos: CellPos, key: string, rows: number, cols: number): CellPos {
  if (rows <= 0 || cols <= 0) return pos;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, v));
  switch (key) {
    case "ArrowUp":
      return { row: clamp(pos.row - 1, rows), col: pos.col };
    case "ArrowDown":
      return { row: clamp(pos.row + 1, rows), col: pos.col };
    case "ArrowLeft":
      return { row: pos.row, col: clamp(pos.col - 1, cols) };
    case "ArrowRight":
      return { row: pos.row, col: clamp(pos.col + 1, cols) };
    case "Home":
      return { row: pos.row, col: 0 };
    case "End":
      return { row: pos.row, col: cols - 1 };
    case "PageUp":
      return { row: clamp(pos.row - 20, rows), col: pos.col };
    case "PageDown":
      return { row: clamp(pos.row + 20, rows), col: pos.col };
    default:
      return pos;
  }
}

/** Cellule suivante pour Tab (retour à la ligne suivante) ; `null` en fin de grille. */
export function nextCell(pos: CellPos, rows: number, cols: number, back = false): CellPos | null {
  const flat = pos.row * cols + pos.col + (back ? -1 : 1);
  if (flat < 0 || flat >= rows * cols) return null;
  return { row: Math.floor(flat / cols), col: flat % cols };
}

/** Sélection de lignes : clic simple, Ctrl/Cmd = bascule, Maj = plage depuis l'ancre. */
export function nextSelection(
  current: ReadonlySet<number>,
  anchor: number | null,
  index: number,
  mods: { shift: boolean; ctrl: boolean },
): { selected: Set<number>; anchor: number } {
  if (mods.shift && anchor !== null) {
    const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
    const selected = mods.ctrl ? new Set(current) : new Set<number>();
    for (let i = a; i <= b; i++) selected.add(i);
    return { selected, anchor };
  }
  if (mods.ctrl) {
    const selected = new Set(current);
    if (!selected.delete(index)) selected.add(index);
    return { selected, anchor: index };
  }
  return { selected: new Set([index]), anchor: index };
}

/** Colonne par défaut d'une nouvelle table. */
export function defaultColumnDef(): DbColumnDef {
  return { name: "id", colType: "INTEGER", primaryKey: true, notNull: false };
}

/** Une colonne est valide si elle a un nom ; les noms doivent être uniques (casse ignorée). */
export function validColumnDefs(cols: DbColumnDef[]): boolean {
  const names = cols.map((c) => c.name.trim().toLowerCase());
  return names.length > 0 && names.every((n) => n !== "") && new Set(names).size === names.length;
}

/** Nom d'objet accepté : non vide et hors espace réservé `sqlite_`. */
export function validObjectName(name: string): boolean {
  const n = name.trim();
  return n !== "" && !n.toLowerCase().startsWith("sqlite_");
}

/** Type de colonne accepté par le backend (lettres, chiffres, espace, `_`, `(`, `)`, `,`). */
export function validColumnType(type: string): boolean {
  return /^[\p{L}\p{N} _,()]{0,64}$/u.test(type.trim());
}
