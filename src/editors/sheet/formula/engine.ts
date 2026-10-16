import type { Cell, Sheet } from "../../../ipc/bindings";
import { EMPTY_CELL, cellToScalar, scalarToCellValue } from "../model";
import type { Locale } from "../numfmt";
import type { Node } from "./ast";
import { evaluateCell } from "./evaluator";
import type { EvalContext } from "./functions";
import { parseFormula } from "./parser";
import { ERR, isErr } from "./values";
import type { Scalar } from "./values";

/** Moteur de calcul : graphe de dépendances + recalcul incrémental. */

const COL_BASE = 16384;
const ROW_BASE = 1048576;
const CLIP_AREA = 100_000;

export const cellKey = (s: number, r: number, c: number): number =>
  (s * ROW_BASE + r) * COL_BASE + c;

function decode(k: number): { s: number; r: number; c: number } {
  const c = k % COL_BASE;
  const q = (k - c) / COL_BASE;
  const r = q % ROW_BASE;
  return { s: (q - r) / ROW_BASE, r, c };
}

interface Dep {
  s: number;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

interface RangeEntry extends Dep {
  owner: number;
}

interface Info {
  sheet: number;
  ast: Node | null;
  deps: Dep[];
  ranges: RangeEntry[];
  volatile: boolean;
}

export interface CellChange {
  sheet: number;
  row: number;
  col: number;
  /** null = effacer. */
  cell: Cell | null;
}

export interface EngineOptions {
  locale: Locale;
  now?: () => Date;
  random?: () => number;
}

const VOLATILE = new Set(["RAND", "NOW", "TODAY"]);
/**
 * À l'ouverture, au-delà de ce nombre de formules dotées d'une valeur en cache, le graphe de
 * dépendances et le recalcul sont différés jusqu'à la première modification (gros classeurs).
 */
const LAZY_FORMULAS = 20_000;

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  switch (node.t) {
    case "unary":
    case "percent":
    case "paren":
      walk(node.arg, visit);
      break;
    case "bin":
      walk(node.l, visit);
      walk(node.r, visit);
      break;
    case "call":
      for (const a of node.args) walk(a, visit);
      break;
    default:
      break;
  }
}

export class Engine {
  sheets: Sheet[] = [];
  locale: Locale;
  private readonly now: () => Date;
  private readonly random: () => number;
  private formulas = new Map<number, Info>();
  private cellDeps = new Map<number, Set<number>>();
  private rangeDeps = new Set<RangeEntry>();
  private volatileKeys = new Set<number>();
  private sheetIndex = new Map<string, number>();
  private parseCache = new Map<string, Node | null>();
  private maxCols = new Map<number, number>();
  private ctx: EvalContext;
  private current = 0;
  /** Vrai tant que formules et dépendances d'un gros classeur ne sont pas enregistrées. */
  private lazy = false;

  constructor(opts: EngineOptions) {
    this.locale = opts.locale;
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random ?? Math.random;
    this.ctx = {
      currentSheet: 0,
      locale: opts.locale,
      resolveSheet: (name) =>
        name === null ? this.current : (this.sheetIndex.get(name.toLowerCase()) ?? -1),
      getCell: (s, r, c) => this.scalarAt(s, r, c),
      getRange: (s, r1, c1, r2, c2) => this.rangeValues(s, r1, c1, r2, c2),
      now: () => this.now(),
      random: () => this.random(),
    };
  }

  setLocale(locale: Locale): void {
    this.locale = locale;
    this.ctx.locale = locale;
  }

  getCell(s: number, r: number, c: number): Cell | undefined {
    return this.sheets[s]?.rows[r]?.[c];
  }

  /** Charge des feuilles et recalcule tout. `initial` conserve les valeurs en cache non calculables. */
  load(sheets: Sheet[], initial = false): void {
    this.sheets = sheets;
    this.formulas.clear();
    this.cellDeps.clear();
    this.rangeDeps.clear();
    this.volatileKeys.clear();
    this.parseCache.clear();
    this.sheetIndex.clear();
    sheets.forEach((s, i) => {
      if (!this.sheetIndex.has(s.name.toLowerCase())) this.sheetIndex.set(s.name.toLowerCase(), i);
    });
    this.lazy = false;
    if (initial) {
      let count = 0;
      let cached = true;
      for (const sheet of sheets) {
        for (const row of sheet.rows) {
          for (const cell of row) {
            if (!cell.f) continue;
            count++;
            if (cell.v.type === "empty") cached = false;
          }
        }
      }
      if (count > LAZY_FORMULAS && cached) {
        this.lazy = true;
        return;
      }
    }
    this.registerAll();
    this.recalc([], true, initial);
  }

  private registerAll(): void {
    this.sheets.forEach((sheet, s) => {
      sheet.rows.forEach((row, r) => {
        row.forEach((cell, c) => {
          if (cell.f) this.register(cellKey(s, r, c), s, cell.f);
        });
      });
    });
  }

  /** Enregistre les formules d'un gros classeur ouvert en différé (première modification). */
  private ensureLoaded(): void {
    if (!this.lazy) return;
    this.lazy = false;
    this.registerAll();
    this.recalc([], true, true);
  }

  /** Applique des modifications de cellules puis recalcule ce qui en dépend. */
  setCells(changes: CellChange[]): void {
    this.ensureLoaded();
    const seeds: number[] = [];
    for (const ch of changes) {
      const sheet = this.sheets[ch.sheet];
      if (!sheet) continue;
      const k = cellKey(ch.sheet, ch.row, ch.col);
      this.unregister(k);
      if (ch.cell === null && (sheet.rows[ch.row]?.length ?? 0) <= ch.col) continue;
      while (sheet.rows.length <= ch.row) sheet.rows.push([]);
      const row = sheet.rows[ch.row] as Cell[];
      while (row.length < ch.col) row.push(EMPTY_CELL);
      row[ch.col] = ch.cell ?? EMPTY_CELL;
      if (ch.cell?.f) this.register(k, ch.sheet, ch.cell.f);
      seeds.push(k);
    }
    this.recalc(seeds, false, false);
  }

  /** Largeur d'une colonne en caractères Excel (nouveau tableau : l'identité change). */
  setColWidth(sheet: number, col: number, chars: number): void {
    const target = this.sheets[sheet];
    if (!target) return;
    const widths = (target.colWidths ?? []).slice();
    while (widths.length <= col) widths.push(null);
    widths[col] = chars;
    target.colWidths = widths;
  }

  recalcAll(): void {
    this.ensureLoaded();
    this.recalc([], true, false);
  }

  // ---------- Graphe ----------

  private parse(f: string): Node | null {
    if (this.parseCache.has(f)) return this.parseCache.get(f) ?? null;
    let ast: Node | null;
    try {
      ast = parseFormula(f);
    } catch {
      ast = null;
    }
    this.parseCache.set(f, ast);
    return ast;
  }

  private register(k: number, sheet: number, f: string): void {
    const ast = this.parse(f);
    const info: Info = { sheet, ast, deps: [], ranges: [], volatile: false };
    if (ast) {
      walk(ast, (n) => {
        if (n.t === "call" && VOLATILE.has(n.name)) info.volatile = true;
        if (n.t !== "ref" && n.t !== "range") return;
        const s = n.sheet === null ? sheet : (this.sheetIndex.get(n.sheet.toLowerCase()) ?? -1);
        if (s < 0) return;
        if (n.t === "ref") {
          info.deps.push({ s, r1: n.row, c1: n.col, r2: n.row, c2: n.col });
        } else {
          info.deps.push({
            s,
            r1: Math.min(n.a.row, n.b.row),
            c1: Math.min(n.a.col, n.b.col),
            r2: Math.max(n.a.row, n.b.row),
            c2: Math.max(n.a.col, n.b.col),
          });
        }
      });
    }
    for (const d of info.deps) {
      if (d.r1 === d.r2 && d.c1 === d.c2) {
        const dk = cellKey(d.s, d.r1, d.c1);
        let set = this.cellDeps.get(dk);
        if (!set) this.cellDeps.set(dk, (set = new Set()));
        set.add(k);
      } else {
        const entry: RangeEntry = { ...d, owner: k };
        info.ranges.push(entry);
        this.rangeDeps.add(entry);
      }
    }
    this.formulas.set(k, info);
    if (info.volatile) this.volatileKeys.add(k);
  }

  private unregister(k: number): void {
    const info = this.formulas.get(k);
    if (!info) return;
    for (const d of info.deps) {
      if (d.r1 === d.r2 && d.c1 === d.c2) {
        const dk = cellKey(d.s, d.r1, d.c1);
        const set = this.cellDeps.get(dk);
        set?.delete(k);
        if (set?.size === 0) this.cellDeps.delete(dk);
      }
    }
    for (const e of info.ranges) this.rangeDeps.delete(e);
    this.formulas.delete(k);
    this.volatileKeys.delete(k);
  }

  private dependentsOf(k: number, out: (d: number) => void): void {
    this.cellDeps.get(k)?.forEach(out);
    if (this.rangeDeps.size === 0) return;
    const { s, r, c } = decode(k);
    for (const e of this.rangeDeps) {
      if (e.s === s && r >= e.r1 && r <= e.r2 && c >= e.c1 && c <= e.c2) out(e.owner);
    }
  }

  // ---------- Lecture ----------

  private scalarAt(s: number, r: number, c: number): Scalar {
    const cell = this.sheets[s]?.rows[r]?.[c];
    return cell ? cellToScalar(cell.v) : null;
  }

  private maxColsOf(s: number): number {
    let n = this.maxCols.get(s);
    if (n === undefined) {
      n = 0;
      for (const row of this.sheets[s]?.rows ?? []) n = Math.max(n, row.length);
      this.maxCols.set(s, n);
    }
    return n;
  }

  private rangeValues(s: number, r1: number, c1: number, r2: number, c2: number): Scalar[][] {
    const sheet = this.sheets[s];
    let rEnd = r2;
    let cEnd = c2;
    if ((r2 - r1 + 1) * (c2 - c1 + 1) > CLIP_AREA) {
      rEnd = Math.min(r2, Math.max(r1, (sheet?.rows.length ?? 1) - 1));
      cEnd = Math.min(c2, Math.max(c1, this.maxColsOf(s) - 1));
    }
    const out: Scalar[][] = [];
    for (let r = r1; r <= rEnd; r++) {
      const row = sheet?.rows[r];
      const line: Scalar[] = [];
      for (let c = c1; c <= cEnd; c++) {
        const cell = row?.[c];
        line.push(cell ? cellToScalar(cell.v) : null);
      }
      out.push(line);
    }
    return out;
  }

  // ---------- Recalcul ----------

  private recalc(seeds: number[], full: boolean, initial: boolean): void {
    this.maxCols.clear();
    const dirty = new Set<number>();
    if (full) {
      for (const k of this.formulas.keys()) dirty.add(k);
    } else {
      const queue: number[] = [];
      const visit = (d: number) => {
        if (!dirty.has(d)) {
          dirty.add(d);
          queue.push(d);
        }
      };
      for (const k of seeds) {
        if (this.formulas.has(k)) visit(k);
        queue.push(k);
      }
      for (const k of this.volatileKeys) visit(k);
      while (queue.length > 0) this.dependentsOf(queue.pop() as number, visit);
    }
    if (dirty.size === 0) return;

    // Arêtes à l'intérieur de l'ensemble sale, puis tri topologique (Kahn)
    const adj = new Map<number, number[]>();
    const indeg = new Map<number, number>();
    for (const d of dirty) indeg.set(d, 0);
    let decoded: { k: number; s: number; r: number; c: number }[] | null = null;
    for (const d of dirty) {
      const info = this.formulas.get(d) as Info;
      const seen = new Set<number>();
      const addEdge = (p: number) => {
        if (!dirty.has(p) || seen.has(p)) return;
        seen.add(p);
        const list = adj.get(p);
        if (list) list.push(d);
        else adj.set(p, [d]);
        indeg.set(d, (indeg.get(d) ?? 0) + 1);
      };
      for (const dep of info.deps) {
        if (dep.r1 === dep.r2 && dep.c1 === dep.c2) {
          addEdge(cellKey(dep.s, dep.r1, dep.c1));
          continue;
        }
        const sheet = this.sheets[dep.s];
        if (!sheet) continue;
        const rMax = Math.min(dep.r2, sheet.rows.length - 1);
        const cMax = Math.min(dep.c2, this.maxColsOf(dep.s) - 1);
        const area = (rMax - dep.r1 + 1) * (cMax - dep.c1 + 1);
        if (area <= 0) continue;
        if (area <= dirty.size) {
          for (let r = dep.r1; r <= rMax; r++)
            for (let c = dep.c1; c <= cMax; c++) addEdge(cellKey(dep.s, r, c));
        } else {
          decoded ??= Array.from(dirty, (k) => ({ k, ...decode(k) }));
          for (const p of decoded) {
            if (p.s === dep.s && p.r >= dep.r1 && p.r <= rMax && p.c >= dep.c1 && p.c <= cMax) {
              addEdge(p.k);
            }
          }
        }
      }
    }

    const queue: number[] = [];
    for (const [k, n] of indeg) if (n === 0) queue.push(k);
    const done = new Set<number>();
    for (let head = 0; head < queue.length; head++) {
      const k = queue[head] as number;
      done.add(k);
      this.evalFormula(k, initial);
      for (const d of adj.get(k) ?? []) {
        const n = (indeg.get(d) ?? 1) - 1;
        indeg.set(d, n);
        if (n === 0) queue.push(d);
      }
    }
    for (const k of dirty) if (!done.has(k)) this.writeValue(k, ERR.CYCLE);
  }

  private evalFormula(k: number, initial: boolean): void {
    const info = this.formulas.get(k) as Info;
    const { s, r, c } = decode(k);
    const cell = this.sheets[s]?.rows[r]?.[c];
    if (!cell) return;
    let value: Scalar;
    if (!info.ast) value = ERR.VALUE;
    else {
      this.current = info.sheet;
      this.ctx.currentSheet = info.sheet;
      try {
        value = evaluateCell(info.ast, this.ctx);
      } catch {
        value = ERR.VALUE;
      }
    }
    // À l'ouverture, une formule que l'on ne sait pas évaluer garde sa valeur en cache
    if (initial && isErr(value) && (value === ERR.NAME || !info.ast) && cell.v.type !== "error") {
      return;
    }
    this.writeValue(k, value);
  }

  private writeValue(k: number, value: Scalar): void {
    const { s, r, c } = decode(k);
    const row = this.sheets[s]?.rows[r];
    const cell = row?.[c];
    if (!row || !cell) return;
    row[c] = { ...cell, v: scalarToCellValue(value) };
  }
}
