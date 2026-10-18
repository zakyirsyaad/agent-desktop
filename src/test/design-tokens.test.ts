import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");
const TEST_DIR = join(SRC, "test");

const PALETTE_UTILITY =
  /\b(?:bg|text|border|ring|outline|fill|stroke|placeholder|divide|from|via|to|decoration|caret|accent|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/g;
const BLACK_WHITE_UTILITY =
  /\b(?:bg|text|border|ring|outline|fill|stroke|placeholder|divide|from|via|to|decoration|caret|accent|shadow)-(?:white|black)(?=\b|\/)/g;
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

function findViolations(): Violation[] {
  return sourceFiles(SRC).flatMap((path) => {
    const file = relative(ROOT, path).split(sep).join("/");
    return readFileSync(path, "utf8")
      .split("\n")
      .flatMap((text, index) =>
        PATTERNS.flatMap((pattern) =>
          [...text.matchAll(pattern)].map((m) => ({ file, line: index + 1, match: m[0] }))
        )
      );
  });
}

// Files not yet migrated to the design system tokens. Each migration task removes its files.
const PENDING: ReadonlySet<string> = new Set<string>([]);

const violations = findViolations();

describe("design tokens", () => {
  it("has no raw colors outside the pending files", () => {
    expect(violations.filter((v) => !PENDING.has(v.file))).toEqual([]);
  });

  it("lists only files that still have raw colors", () => {
    const dirty = new Set(violations.map((v) => v.file));
    expect([...PENDING].filter((f) => !dirty.has(f))).toEqual([]);
  });
});
