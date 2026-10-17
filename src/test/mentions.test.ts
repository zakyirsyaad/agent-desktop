import { describe, it, expect } from "vitest";
import { matchFiles, mentionAt } from "../lib/mentions";

describe("mentionAt", () => {
  it("finds the @word the caret is in", () => {
    expect(mentionAt("look at @src/ap", 15)).toEqual({ start: 8, end: 15, query: "src/ap" });
    expect(mentionAt("@App", 4)).toEqual({ start: 0, end: 4, query: "App" });
    expect(mentionAt("see @", 5)).toEqual({ start: 4, end: 5, query: "" });
  });

  it("covers the whole @word when the caret is inside it, matching on what is before the caret", () => {
    expect(mentionAt("@app more", 2)).toEqual({ start: 0, end: 4, query: "a" });
  });

  it("ignores an @ inside a word, like an email address, or a word the caret has left", () => {
    expect(mentionAt("mail me@example.com", 19)).toBeNull();
    expect(mentionAt("@app and more", 13)).toBeNull();
    expect(mentionAt("no mention", 10)).toBeNull();
  });
});

describe("matchFiles", () => {
  const files = ["README.md", "src/App.tsx", "src/app-info.ts", "src/test/app.test.ts", "docs/mapping.md"];

  it("ranks a file name that starts with the query above one that only contains it", () => {
    expect(matchFiles(files, "app")).toEqual(["src/App.tsx", "src/app-info.ts", "src/test/app.test.ts", "docs/mapping.md"]);
  });

  it("matches folders in the query against the path", () => {
    expect(matchFiles(files, "test/app")).toEqual(["src/test/app.test.ts"]);
  });

  it("offers the first files for an empty query, at most the limit", () => {
    expect(matchFiles(files, "", 2)).toEqual(["README.md", "src/App.tsx"]);
  });
});
