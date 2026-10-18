import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/styles/globals.css", "utf8");

/** The body of the `@media (prefers-color-scheme: light)` block, or "". */
function lightBlock(): string {
  const start = css.indexOf("@media (prefers-color-scheme: light)");
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return "";
}

const block = lightBlock();
const light = new Map<string, string>();
for (const [, name, value] of block.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
  light.set(name, value);
}

function channel(hex: string, offset: number): number {
  const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function token(name: string): string {
  const value = light.get(name);
  if (!value) throw new Error(`light block has no hex --color-${name}`);
  return value;
}

function expectContrast(fg: string, bg: string, floor: number) {
  const r = ratio(token(fg), token(bg));
  expect(r, `${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${floor}:1`).toBeGreaterThanOrEqual(floor);
}

const SURFACES = ["bg", "surface-1", "surface-2", "surface-3"];
const TEXT = [
  "fg", "fg-secondary", "fg-muted", "fg-subtle",
  "status-running", "status-attention", "status-unread", "status-merged", "danger",
];

describe("light theme contrast", () => {
  it("defines a light block", () => {
    expect(block).not.toBe("");
  });

  it.each(SURFACES)("text is readable on %s", (surface) => {
    for (const fg of TEXT) expectContrast(fg, surface, 4.5);
  });

  it("text is readable on surface-hover", () => {
    for (const fg of TEXT.filter((t) => t !== "fg-subtle")) expectContrast(fg, "surface-hover", 4.5);
  });

  it.each(["bg", "surface-1", "surface-2", "surface-hover"])("edges and focus ring show on %s", (surface) => {
    expectContrast("border-strong", surface, 3);
    expectContrast("focus-ring", surface, 3);
  });

  it("pairs used together are readable", () => {
    expectContrast("danger", "danger-surface", 4.5);
    for (const fg of ["fg", "fg-secondary", "fg-subtle"]) expectContrast(fg, "attention-surface", 4.5);
    expectContrast("on-primary", "primary", 4.5);
    expectContrast("on-primary", "primary-hover", 4.5);
  });

  it("keeps the terminal colors fixed", () => {
    expect(block).not.toContain("--color-terminal-bg");
    expect(block).not.toContain("--color-terminal-fg-subtle");
  });

  it("terminal empty-state text is readable on the terminal background", () => {
    const fixed = (name: string) => {
      const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
      if (!m) throw new Error(`@theme has no hex --color-${name}`);
      return m[1];
    };
    const r = ratio(fixed("terminal-fg-subtle"), fixed("terminal-bg"));
    expect(r, `terminal-fg-subtle on terminal-bg is ${r.toFixed(2)}:1, needs 4.5:1`).toBeGreaterThanOrEqual(4.5);
  });
});
