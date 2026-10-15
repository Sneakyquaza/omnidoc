import { describe, expect, it } from "vitest";
import { basename, extOf } from "./paths";

describe("chemins", () => {
  it("extrait le nom et l'extension", () => {
    expect(basename("/a/b/c.TXT")).toBe("c.TXT");
    expect(basename("C:\\x\\y.md")).toBe("y.md");
    expect(extOf("/a/b/c.TXT")).toBe("txt");
    expect(extOf("/a/.bashrc")).toBe("");
    expect(extOf("/a/Makefile")).toBe("");
  });
});
