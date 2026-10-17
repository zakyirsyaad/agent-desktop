import { describe, it, expect } from "vitest";
import { CODE_BLOCK_PLACEHOLDER, toSpeakableText } from "../lib/speech";

/** Collapse runs of blank lines so assertions do not depend on spacing choices. */
function normalizeLines(text: string): string {
  return text.replace(/\n{2,}/g, "\n").trim();
}

describe("CODE_BLOCK_PLACEHOLDER", () => {
  it("is the phrase read out in place of a code block", () => {
    expect(CODE_BLOCK_PLACEHOLDER).toBe("code block omitted");
  });
});

describe("toSpeakableText", () => {
  it("replaces a tagged fenced code block with the placeholder and keeps surrounding text", () => {
    const markdown = [
      "Here is the plan:",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "All done.",
    ].join("\n");

    const spoken = toSpeakableText(markdown);

    expect(normalizeLines(spoken)).toBe(
      `Here is the plan:\n${CODE_BLOCK_PLACEHOLDER}\nAll done.`,
    );
    expect(spoken).not.toContain("```");
    expect(spoken).not.toContain("const answer = 42;");
  });

  it("replaces a fence that carries no language tag", () => {
    const markdown = "Top\n```\nplain text inside\n```\nBottom";

    expect(normalizeLines(toSpeakableText(markdown))).toBe(
      `Top\n${CODE_BLOCK_PLACEHOLDER}\nBottom`,
    );
  });

  it("keeps several fenced blocks as one placeholder each", () => {
    const markdown = [
      "```bash",
      "pnpm install",
      "```",
      "middle",
      "```json",
      '{ "a": 1 }',
      "```",
    ].join("\n");

    const spoken = toSpeakableText(markdown);

    expect(spoken.split(CODE_BLOCK_PLACEHOLDER)).toHaveLength(3);
    expect(normalizeLines(spoken)).toBe(
      `${CODE_BLOCK_PLACEHOLDER}\nmiddle\n${CODE_BLOCK_PLACEHOLDER}`,
    );
  });

  it("swallows the rest of the text when a fence is never closed", () => {
    const markdown = "Before the block\n\n```bash\npnpm test\nand everything after";

    const spoken = toSpeakableText(markdown);

    expect(normalizeLines(spoken)).toBe(`Before the block\n${CODE_BLOCK_PLACEHOLDER}`);
    expect(spoken).not.toContain("pnpm test");
    expect(spoken).not.toContain("and everything after");
  });

  it("strips inline code backticks but keeps the code text", () => {
    expect(toSpeakableText("run `pnpm test` now")).toBe("run pnpm test now");
  });

  it("strips bold markers", () => {
    expect(toSpeakableText("**Important** note")).toBe("Important note");
  });

  it("strips leading heading hashes", () => {
    expect(toSpeakableText("# Title")).toBe("Title");
    expect(toSpeakableText("## Plan")).toBe("Plan");
    expect(toSpeakableText("### Step three")).toBe("Step three");
    expect(toSpeakableText("###### Step six")).toBe("Step six");
  });

  it("strips heading hashes on inner lines of a multi-line document", () => {
    const markdown = "## Plan\n\n- step one\n- **step two**";

    const spoken = toSpeakableText(markdown);

    expect(normalizeLines(spoken)).toBe("Plan\n- step one\n- step two");
  });

  it("leaves a hash that is not a heading marker alone", () => {
    expect(toSpeakableText("C# is fun")).toBe("C# is fun");
    expect(toSpeakableText("####### seven hashes")).toBe("####### seven hashes");
  });

  it("leaves plain text unchanged apart from trimming", () => {
    expect(toSpeakableText("  hello world  ")).toBe("hello world");
    expect(toSpeakableText("line one\nline two")).toBe("line one\nline two");
  });

  it("returns an empty string for empty and whitespace-only input", () => {
    expect(toSpeakableText("")).toBe("");
    expect(toSpeakableText("   \n  ")).toBe("");
  });

  it("produces text with no markdown punctuation left to read aloud", () => {
    const markdown = [
      "## Summary",
      "",
      "Edit **`src/lib/speech.ts`** then run:",
      "",
      "```bash",
      "pnpm test",
      "```",
    ].join("\n");

    const spoken = toSpeakableText(markdown);

    expect(spoken).not.toContain("`");
    expect(spoken).not.toContain("*");
    expect(spoken).not.toContain("#");
    expect(spoken).toContain(CODE_BLOCK_PLACEHOLDER);
    expect(spoken).toContain("src/lib/speech.ts");
  });

  it("is pure: calling it twice yields the same result", () => {
    const markdown = "## Plan\n\n```ts\nx\n```\nDone";

    expect(toSpeakableText(markdown)).toBe(toSpeakableText(markdown));
  });
});
