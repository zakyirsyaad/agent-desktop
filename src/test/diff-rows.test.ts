import { describe, it, expect } from "vitest";
import { countChanges, diffRows } from "../lib/diff-rows";

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

describe("diffRows", () => {
  it("marks removed and added lines and keeps short unchanged runs", () => {
    const rows = diffRows("a\nb\nc\n", "a\nB\nc\n");

    expect(rows.map((r) => `${r.kind}:${r.text}`)).toEqual(["context:a", "removed:b", "added:B", "context:c"]);
    expect(countChanges(rows)).toEqual({ added: 1, removed: 1 });
  });

  it("folds long unchanged runs, keeping three lines of context next to each change", () => {
    const before = lines(20);
    const after = before.replace("line 10\n", "line ten\n");

    const rows = diffRows(before, after);

    expect(rows.map((r) => r.kind)).toEqual([
      "skipped", "context", "context", "context", "removed", "added", "context", "context", "context", "skipped",
    ]);
    expect(rows[0].text).toBe("6 unchanged lines");
    expect(rows[rows.length - 1].text).toBe("7 unchanged lines");
  });

  it("shows every line of a new file as added", () => {
    expect(countChanges(diffRows(null, "x\ny\n"))).toEqual({ added: 2, removed: 0 });
  });

  it("stops after a bounded number of rows, saying how many it left out", () => {
    const rows = diffRows(null, lines(5000));

    expect(rows.length).toBe(1501);
    expect(rows[1500]).toEqual({ kind: "skipped", text: "3500 more lines not shown" });
  });
});

