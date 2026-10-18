import { describe, it, expect } from "vitest";
import { formatLineCount, targetLabel, totalsOf, type FileStat } from "../lib/diff-stats";

const stat = (added: number, removed: number): FileStat => ({
  path: "a.ts",
  oldPath: null,
  kind: "modified",
  added,
  removed,
  isBinary: false,
});

describe("formatLineCount", () => {
  it("groups thousands", () => expect(formatLineCount(2847)).toBe("2,847"));
  it("keeps zero", () => expect(formatLineCount(0)).toBe("0"));
});

describe("totalsOf", () => {
  it("sums added and removed lines", () => {
    expect(totalsOf([stat(2, 1), stat(2845, 34)])).toEqual({ added: 2847, removed: 35 });
  });
  it("is zero for no files", () => expect(totalsOf([])).toEqual({ added: 0, removed: 0 }));
});

describe("targetLabel", () => {
  it("names the base branch", () => {
    expect(targetLabel("base", { base: { name: "main" } })).toBe("main → working tree");
  });
  it("names HEAD", () => {
    expect(targetLabel("head", { base: { name: "main" } })).toBe("HEAD → working tree");
  });
});
