import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");
const TEST_DIR = join(SRC, "test");

const PALETTE_UTILITY =
  /\b(?:bg|text|border(?:-[trblxyse])?|ring|outline|fill|stroke|placeholder|divide(?:-[xy])?|from|via|to|decoration|caret|accent|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/g;
const BLACK_WHITE_UTILITY =
  /\b(?:bg|text|border(?:-[trblxyse])?|ring|outline|fill|stroke|placeholder|divide(?:-[xy])?|from|via|to|decoration|caret|accent|shadow)-(?:white|black)(?=\b|\/)/g;
const ARBITRARY_HEX = /-\[#[0-9a-fA-F]+/g;
const PATTERNS = [PALETTE_UTILITY, BLACK_WHITE_UTILITY, ARBITRARY_HEX];

interface Violation {
  file: string;
  line: number;
  match: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === TEST_DIR ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function rawColorsIn(text: string): string[] {
  return PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[0]));
}

function findViolations(): Violation[] {
  return sourceFiles(SRC).flatMap((path) => {
    const file = relative(ROOT, path).split(sep).join("/");
    return readFileSync(path, "utf8")
      .split("\n")
      .flatMap((text, index) =>
        rawColorsIn(text).map((match) => ({ file, line: index + 1, match }))
      );
  });
}

const violations = findViolations();

describe("design tokens", () => {
  it("has no raw colors in src", () => {
    expect(violations).toEqual([]);
  });

  it("catches side and axis prefixed utilities", () => {
    expect(rawColorsIn("border-l-amber-500 border-t-neutral-800 divide-y-red-500")).toEqual([
      "border-l-amber-500",
      "border-t-neutral-800",
      "divide-y-red-500",
    ]);
  });
});
