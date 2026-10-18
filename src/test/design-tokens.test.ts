import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { XTERM_OPTIONS } from "../lib/xterm-options";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");
const TEST_DIR = join(SRC, "test");

const PALETTE_UTILITY =
  /\b(?:bg|text|border(?:-[trblxyse])?|ring|outline|fill|stroke|placeholder|divide(?:-[xy])?|from|via|to|decoration|caret|accent|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/g;
const BLACK_WHITE_UTILITY =
  /\b(?:bg|text|border(?:-[trblxyse])?|ring|outline|fill|stroke|placeholder|divide(?:-[xy])?|from|via|to|decoration|caret|accent|shadow)-(?:white|black)(?=\b|\/)/g;
const ARBITRARY_HEX = /-\[#[0-9a-fA-F]+/g;
const ARBITRARY_COLOR_FUNCTION = /-\[(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/g;
const PATTERNS = [PALETTE_UTILITY, BLACK_WHITE_UTILITY, ARBITRARY_HEX, ARBITRARY_COLOR_FUNCTION];

/** An inline `style={{ … }}` object, possibly over several lines. */
const INLINE_STYLE = /style=\{\{[\s\S]*?\}\}/g;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch)\(/;

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

/** Inline style objects that carry a literal color (hex, rgb(), hsl()…). */
function inlineStyleColorsIn(text: string): { index: number; match: string }[] {
  return [...text.matchAll(INLINE_STYLE)]
    .filter((m) => COLOR_LITERAL.test(m[0]))
    .map((m) => ({ index: m.index ?? 0, match: m[0] }));
}

function findViolations(): Violation[] {
  return sourceFiles(SRC).flatMap((path) => {
    const file = relative(ROOT, path).split(sep).join("/");
    const source = readFileSync(path, "utf8");
    const inClasses = source
      .split("\n")
      .flatMap((text, index) =>
        rawColorsIn(text).map((match) => ({ file, line: index + 1, match }))
      );
    const inStyles = inlineStyleColorsIn(source).map(({ index, match }) => ({
      file,
      line: source.slice(0, index).split("\n").length,
      match,
    }));
    return [...inClasses, ...inStyles];
  });
}

/** A `--color-*` value as declared in the @theme block of globals.css. */
function themeColor(name: string): string {
  const css = readFileSync(join(SRC, "styles", "globals.css"), "utf8");
  const value = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(css)?.[1].trim();
  if (!value) throw new Error(`--color-${name} is not declared in globals.css`);
  return value;
}

function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const violations = findViolations();

describe("design tokens", () => {
  it("has no raw colors in src", () => {
    expect(violations).toEqual([]);
  });

  it("has no raw colors in index.html", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    expect(rawColorsIn(html)).toEqual([]);
  });

  it("catches side and axis prefixed utilities", () => {
    expect(rawColorsIn("border-l-amber-500 border-t-neutral-800 divide-y-red-500")).toEqual([
      "border-l-amber-500",
      "border-t-neutral-800",
      "divide-y-red-500",
    ]);
  });

  it("catches non-hex arbitrary colors", () => {
    expect(rawColorsIn("bg-[rgba(0,0,0,0.7)] text-[hsl(0,0%,50%)]")).toEqual([
      "-[rgba(",
      "-[hsl(",
    ]);
  });

  it("catches colors inside inline style objects, even over several lines", () => {
    const source = 'a\n<div style={{\n  boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }} />\n<b style={{ paddingLeft: 78 }} />';
    expect(inlineStyleColorsIn(source).map((v) => v.match)).toEqual([
      'style={{\n  boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}',
    ]);
  });

  it("keeps the terminal colors in step with the tokens", () => {
    const { theme } = XTERM_OPTIONS;
    expect(theme?.background).toBe(themeColor("bg"));
    expect(theme?.foreground).toBe(themeColor("fg-secondary"));
    expect(theme?.cursor).toBe(themeColor("fg"));
    expect(theme?.selectionBackground).toBe(hexToRgba(themeColor("fg"), 0.2));
  });
});
