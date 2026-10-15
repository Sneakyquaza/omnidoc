import type { ArchiveEntry } from "../../ipc/bindings";

export interface TreeNode {
  name: string;
  /** Chemin complet (« / » comme séparateur, sans « / » final) ; "" pour la racine. */
  path: string;
  isDir: boolean;
  size: number;
  compressedSize: number | null;
  modified: string | null;
  /** Dossiers : enfants (non triés). */
  children: TreeNode[];
}

export type SortKey = "name" | "size" | "compressed" | "ratio" | "modified";
export type SortDir = "asc" | "desc";

function newDir(name: string, path: string): TreeNode {
  return { name, path, isDir: true, size: 0, compressedSize: null, modified: null, children: [] };
}

/** Construit l'arbre à partir des chemins plats ; les dossiers implicites sont créés. */
export function buildTree(entries: ArchiveEntry[]): TreeNode {
  const root = newDir("", "");
  const dirs = new Map<string, TreeNode>([["", root]]);

  function ensureDir(path: string): TreeNode {
    const existing = dirs.get(path);
    if (existing) return existing;
    const cut = path.lastIndexOf("/");
    const parent = ensureDir(cut < 0 ? "" : path.slice(0, cut));
    const node = newDir(path.slice(cut + 1), path);
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  }

  for (const entry of entries) {
    const path = entry.path.replace(/\/+$/, "");
    if (path === "") continue;
    if (entry.isDir) {
      ensureDir(path).modified = entry.modified;
      continue;
    }
    const cut = path.lastIndexOf("/");
    const parent = ensureDir(cut < 0 ? "" : path.slice(0, cut));
    parent.children.push({
      name: path.slice(cut + 1),
      path,
      isDir: false,
      size: entry.size,
      compressedSize: entry.compressedSize,
      modified: entry.modified,
      children: [],
    });
  }

  // Taille d'un dossier = somme des fichiers qu'il contient
  function total(node: TreeNode): void {
    if (!node.isDir) return;
    let size = 0;
    let compressed: number | null = 0;
    for (const child of node.children) {
      total(child);
      size += child.size;
      compressed =
        compressed !== null && child.compressedSize !== null
          ? compressed + child.compressedSize
          : null;
    }
    node.size = size;
    node.compressedSize = node.children.length > 0 ? compressed : null;
  }
  total(root);
  return root;
}

export function findNode(root: TreeNode, path: string): TreeNode | null {
  if (path === "") return root;
  let node = root;
  for (const part of path.split("/")) {
    const next = node.children.find((c) => c.isDir && c.name === part);
    if (!next) return null;
    node = next;
  }
  return node;
}

export function parentPath(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

export function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

export function breadcrumbs(path: string): { name: string; path: string }[] {
  if (path === "") return [];
  const parts = path.split("/");
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
}

/** Gain de compression en pourcentage (0–100), `null` si inconnu. */
export function ratio(size: number, compressedSize: number | null): number | null {
  if (compressedSize === null || size <= 0) return null;
  return Math.max(0, Math.round((1 - compressedSize / size) * 100));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ["Kio", "Mio", "Gio", "Tio"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDate(iso: string | null): string {
  if (iso === null) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function compareBy(key: SortKey): (a: TreeNode, b: TreeNode) => number {
  switch (key) {
    case "size":
      return (a, b) => a.size - b.size;
    case "compressed":
      return (a, b) => (a.compressedSize ?? -1) - (b.compressedSize ?? -1);
    case "ratio":
      return (a, b) =>
        (ratio(a.size, a.compressedSize) ?? -1) - (ratio(b.size, b.compressedSize) ?? -1);
    case "modified":
      return (a, b) => (a.modified ?? "").localeCompare(b.modified ?? "");
    default:
      return (a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  }
}

/** Tri stable ; les dossiers restent toujours avant les fichiers. */
export function sortNodes(nodes: TreeNode[], key: SortKey, dir: SortDir): TreeNode[] {
  const cmp = compareBy(key);
  const byName = compareBy("name");
  const sign = dir === "asc" ? 1 : -1;
  return [...nodes].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return sign * cmp(a, b) || byName(a, b);
  });
}

/** Descendants (récursifs) du dossier dont le nom contient `query` (insensible à la casse). */
export function filterNodes(dir: TreeNode, query: string): TreeNode[] {
  const q = query.trim().toLowerCase();
  if (q === "") return dir.children;
  const out: TreeNode[] = [];
  const walk = (node: TreeNode) => {
    for (const child of node.children) {
      if (child.name.toLowerCase().includes(q)) out.push(child);
      if (child.isDir) walk(child);
    }
  };
  walk(dir);
  return out;
}

export interface DirRow {
  node: TreeNode;
  depth: number;
  hasSubdirs: boolean;
}

/** Dossiers visibles de l'arbre latéral (racine incluse), selon les dossiers dépliés. */
export function flattenDirs(root: TreeNode, expanded: ReadonlySet<string>): DirRow[] {
  const rows: DirRow[] = [];
  const walk = (node: TreeNode, depth: number) => {
    const subdirs = node.children.filter((c) => c.isDir);
    rows.push({ node, depth, hasSubdirs: subdirs.length > 0 });
    if (node.path === "" || expanded.has(node.path)) {
      for (const d of sortNodes(subdirs, "name", "asc")) walk(d, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** Chemins des dossiers parents d'un chemin (sans le chemin lui-même ni la racine). */
export function ancestors(path: string): string[] {
  return breadcrumbs(path)
    .slice(0, -1)
    .map((b) => b.path);
}

export function countFiles(entries: ArchiveEntry[]): { files: number; size: number } {
  let files = 0;
  let size = 0;
  for (const e of entries) {
    if (!e.isDir) {
      files++;
      size += e.size;
    }
  }
  return { files, size };
}
