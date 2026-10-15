import { describe, expect, it } from "vitest";
import type { ArchiveEntry } from "../../ipc/bindings";
import {
  ancestors,
  breadcrumbs,
  buildTree,
  countFiles,
  filterNodes,
  findNode,
  flattenDirs,
  formatSize,
  ratio,
  sortNodes,
} from "./tree";

function file(path: string, size: number, compressedSize: number | null = null): ArchiveEntry {
  return { path, size, compressedSize, isDir: false, modified: null };
}

const entries: ArchiveEntry[] = [
  { path: "docs", size: 0, compressedSize: null, isDir: true, modified: null },
  file("docs/a.txt", 100, 50),
  file("docs/sub/deep/b.md", 2000, 500),
  file("readme.md", 10, 10),
];

describe("buildTree", () => {
  it("crée les dossiers implicites", () => {
    const root = buildTree(entries);
    expect(root.children.map((c) => c.name).sort()).toEqual(["docs", "readme.md"]);
    const deep = findNode(root, "docs/sub/deep");
    expect(deep?.isDir).toBe(true);
    expect(deep?.children[0]?.path).toBe("docs/sub/deep/b.md");
    expect(findNode(root, "docs/sub")?.children).toHaveLength(1);
  });

  it("cumule les tailles des dossiers", () => {
    const root = buildTree(entries);
    expect(findNode(root, "docs")?.size).toBe(2100);
    expect(findNode(root, "docs")?.compressedSize).toBe(550);
    expect(root.size).toBe(2110);
  });

  it("ignore le slash final des dossiers", () => {
    const root = buildTree([
      { path: "x/", size: 0, compressedSize: null, isDir: true, modified: null },
    ]);
    expect(findNode(root, "x")).not.toBeNull();
  });
});

describe("sortNodes", () => {
  const root = buildTree(entries);
  it("place les dossiers d'abord", () => {
    expect(sortNodes(root.children, "name", "desc").map((n) => n.name)).toEqual([
      "docs",
      "readme.md",
    ]);
  });
  it("trie par taille", () => {
    const nodes = [file("b", 5), file("a", 9), file("c", 1)].map(
      (e) => buildTree([e]).children[0]!,
    );
    expect(sortNodes(nodes, "size", "desc").map((n) => n.name)).toEqual(["a", "b", "c"]);
    expect(sortNodes(nodes, "size", "asc").map((n) => n.name)).toEqual(["c", "b", "a"]);
  });
  it("tri naturel des noms", () => {
    const nodes = ["f10", "f2", "f1"].map((p) => buildTree([file(p, 1)]).children[0]!);
    expect(sortNodes(nodes, "name", "asc").map((n) => n.name)).toEqual(["f1", "f2", "f10"]);
  });
});

describe("utilitaires", () => {
  it("formate les tailles", () => {
    expect(formatSize(0)).toBe("0 o");
    expect(formatSize(1023)).toBe("1023 o");
    expect(formatSize(1536)).toBe("1.5 Kio");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 Mio");
    expect(formatSize(200 * 1024)).toBe("200 Kio");
  });
  it("calcule le ratio", () => {
    expect(ratio(100, 25)).toBe(75);
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(100, null)).toBeNull();
    expect(ratio(10, 20)).toBe(0);
  });
  it("fil d'Ariane", () => {
    expect(breadcrumbs("")).toEqual([]);
    expect(breadcrumbs("a/b")).toEqual([
      { name: "a", path: "a" },
      { name: "b", path: "a/b" },
    ]);
  });
  it("filtre récursivement par nom", () => {
    const root = buildTree(entries);
    expect(filterNodes(root, "B.MD").map((n) => n.path)).toEqual(["docs/sub/deep/b.md"]);
    expect(filterNodes(root, "")).toBe(root.children);
  });
  it("compte les fichiers", () => {
    expect(countFiles(entries)).toEqual({ files: 3, size: 2110 });
  });
  it("n'affiche que les dossiers dépliés dans l'arbre latéral", () => {
    const root = buildTree(entries);
    expect(flattenDirs(root, new Set()).map((r) => r.node.path)).toEqual(["", "docs"]);
    const open = flattenDirs(root, new Set(["docs", "docs/sub"]));
    expect(open.map((r) => [r.node.path, r.depth])).toEqual([
      ["", 0],
      ["docs", 1],
      ["docs/sub", 2],
      ["docs/sub/deep", 3],
    ]);
    expect(open[3]?.hasSubdirs).toBe(false);
  });
  it("liste les ancêtres", () => {
    expect(ancestors("a/b/c")).toEqual(["a", "a/b"]);
    expect(ancestors("a")).toEqual([]);
  });
});
