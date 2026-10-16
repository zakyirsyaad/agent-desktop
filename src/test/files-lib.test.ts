import { describe, it, expect } from "vitest";
import {
  ancestorPaths,
  filterVisiblePaths,
  joinWorkspacePath,
  parseDirEntries,
  type DirEntryInfo,
} from "../lib/files";

function entry(relativePath: string, isDir = false): DirEntryInfo {
  return { name: relativePath.split("/").pop() ?? relativePath, relativePath, isDir };
}

describe("joinWorkspacePath", () => {
  it("joins the root and a relative path with one slash", () => {
    expect(joinWorkspacePath("/Users/test/proj", "src/main.ts")).toBe("/Users/test/proj/src/main.ts");
    expect(joinWorkspacePath("/Users/test/proj/", "README.md")).toBe("/Users/test/proj/README.md");
  });
});

describe("ancestorPaths", () => {
  it("returns every parent folder from the top down", () => {
    expect(ancestorPaths("a/b/c.txt")).toEqual(["a", "a/b"]);
    expect(ancestorPaths("top.txt")).toEqual([]);
  });
});

describe("filterVisiblePaths", () => {
  const children = {
    "": [entry("src", true), entry("README.md")],
    src: [entry("src/components", true), entry("src/main.ts")],
    "src/components": [entry("src/components/Button.tsx")],
  };

  it("returns null for an empty or blank query", () => {
    expect(filterVisiblePaths(children, "")).toBeNull();
    expect(filterVisiblePaths(children, "   ")).toBeNull();
  });

  it("returns matches plus their parent folders, case-insensitively", () => {
    const visible = filterVisiblePaths(children, "BUTTON");

    expect(visible && [...visible].sort()).toEqual(["src", "src/components", "src/components/Button.tsx"]);
  });

  it("returns an empty set when nothing loaded matches", () => {
    expect(filterVisiblePaths(children, "zzz")?.size).toBe(0);
  });
});

describe("parseDirEntries", () => {
  it("accepts a well-formed listing", () => {
    const listing = [entry("src", true), entry("a.txt")];

    expect(parseDirEntries(listing)).toEqual(listing);
  });

  it("rejects anything that is not a list of entries", () => {
    expect(() => parseDirEntries(undefined)).toThrow();
    expect(() => parseDirEntries([{ name: "a" }])).toThrow();
  });
});
