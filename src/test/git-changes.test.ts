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
      { kind: "context", text: "one" },
      { kind: "removed", text: "two" },
      { kind: "added", text: "2" },
      { kind: "note", text: "\\ No newline at end of file" },
    ]);
  });

  it("keeps a line whose content starts like a header marker", () => {
    expect(unifiedDiffRows("@@ -1 +1 @@\n---- divider\n+++ plus\n")).toEqual([
      { kind: "hunk", text: "@@ -1 +1 @@" },
      { kind: "removed", text: "--- divider" },
      { kind: "added", text: "++ plus" },
    ]);
  });

  it("stops after a bounded number of rows", () => {
    const rows = unifiedDiffRows(Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join("\n"));

    expect(rows).toHaveLength(1501);
    expect(rows.at(-1)).toEqual({ kind: "note", text: "500 more lines not shown" });
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
