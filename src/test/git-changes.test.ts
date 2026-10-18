import { describe, it, expect } from "vitest";
import { commitPathsOf, unifiedDiffRows } from "../lib/git-changes";

describe("unifiedDiffRows", () => {
  it("drops git's file header and marks hunks, changes and context", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+2",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    expect(unifiedDiffRows(diff)).toEqual([
      { kind: "hunk", text: "@@ -1,3 +1,3 @@" },
      { kind: "context", text: "one", oldLine: 1, newLine: 1 },
      { kind: "removed", text: "two", oldLine: 2 },
      { kind: "added", text: "2", newLine: 2 },
      { kind: "note", text: "\\ No newline at end of file" },
    ]);
  });

  it("keeps a line whose content starts like a header marker", () => {
    expect(unifiedDiffRows("@@ -1 +1 @@\n---- divider\n+++ plus\n")).toEqual([
      { kind: "hunk", text: "@@ -1 +1 @@" },
      { kind: "removed", text: "--- divider", oldLine: 1 },
      { kind: "added", text: "++ plus", newLine: 1 },
    ]);
  });

  it("stops after a bounded number of rows", () => {
    const rows = unifiedDiffRows(Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join("\n"));

    expect(rows).toHaveLength(1501);
    expect(rows.at(-1)).toEqual({ kind: "note", text: "500 more lines not shown" });
  });
});

describe("unifiedDiffRows line numbers", () => {
  it("numbers context, removed and added rows from the hunk header", () => {
    const diff = "@@ -10,3 +10,4 @@\n ctx\n-old\n+new\n+more\n ctx2\n";
    expect(unifiedDiffRows(diff)).toEqual([
      { kind: "hunk", text: "@@ -10,3 +10,4 @@" },
      { kind: "context", text: "ctx", oldLine: 10, newLine: 10 },
      { kind: "removed", text: "old", oldLine: 11 },
      { kind: "added", text: "new", newLine: 11 },
      { kind: "added", text: "more", newLine: 12 },
      { kind: "context", text: "ctx2", oldLine: 12, newLine: 13 },
    ]);
  });

  it("starts at 1 when the hunk header omits a count", () => {
    expect(unifiedDiffRows("@@ -0,0 +1 @@\n+first\n")[1]).toEqual({ kind: "added", text: "first", newLine: 1 });
  });
});

describe("commitPathsOf", () => {
  it("includes where a renamed file came from", () => {
    expect(
      commitPathsOf([
        { path: "new.md", oldPath: "old.md", kind: "renamed" },
        { path: "a.ts", oldPath: null, kind: "modified" },
      ]),
    ).toEqual(["new.md", "old.md", "a.ts"]);
  });
});
