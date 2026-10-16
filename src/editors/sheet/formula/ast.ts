/** Arbre syntaxique des formules. */

export interface RefParts {
  sheet: string | null;
  row: number;
  col: number;
  absRow: boolean;
  absCol: boolean;
}

export type CornerParts = Omit<RefParts, "sheet">;

export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "err"; v: string }
  | { t: "empty" }
  | { t: "name"; name: string }
  | ({ t: "ref" } & RefParts)
  | { t: "range"; sheet: string | null; a: CornerParts; b: CornerParts }
  | { t: "unary"; op: "-" | "+"; arg: Node }
  | { t: "percent"; arg: Node }
  | { t: "paren"; arg: Node }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "call"; name: string; args: Node[] };

export class FormulaSyntaxError extends Error {}
