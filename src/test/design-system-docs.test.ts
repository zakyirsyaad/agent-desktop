import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const css = readFileSync(join(ROOT, "src", "styles", "globals.css"), "utf8");

interface ThemedToken {
  name: string;
  value: string | { dark: string; light?: string };
}

interface TokensDoc {
  color: { tokens: ThemedToken[] };
  shadow: { tokens: ThemedToken[] };
}

const doc: TokensDoc = JSON.parse(
  readFileSync(join(ROOT, "docs", "design-system", "tokens.json"), "utf8")
);

/** The text between the braces that follow `opener`, or "". */
function blockAfter(opener: string): string {
  const start = css.indexOf(opener);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return "";
}

/** `--<prefix>-<name>: <value>;` declarations in a block, values without spaces. */
function declarations(block: string, prefix: string): Map<string, string> {
  const pattern = new RegExp(`--${prefix}-([\\w-]+):\\s*([^;]+);`, "g");
  return new Map(
    [...block.matchAll(pattern)]
      .filter(([, name]) => name !== "*")
      .map(([, name, value]) => [name, value.replace(/\s+/g, "")])
  );
}

const lightBlock = blockAfter("@media (prefers-color-scheme: light)");
const dark = {
  color: declarations(blockAfter("@theme"), "color"),
  elevation: declarations(blockAfter(":root"), "elevation"),
};
const light = {
  color: declarations(lightBlock, "color"),
  elevation: declarations(lightBlock, "elevation"),
};

/** A token's documented value per theme, spaces removed so `rgba(0, 0, 0, 0.7)` matches. */
function documented(token: ThemedToken): { dark: string; light: string } {
  const value = typeof token.value === "string" ? { dark: token.value } : token.value;
  const strip = (v: string) => v.replace(/\s+/g, "");
  return { dark: strip(value.dark), light: strip(value.light ?? value.dark) };
}

function inCode(kind: "color" | "elevation", name: string): { dark?: string; light?: string } {
  const d = dark[kind].get(name);
  // A token the light block leaves alone (the terminal's) keeps its dark value.
  return { dark: d, light: light[kind].get(name) ?? d };
}

describe("docs/design-system/tokens.json", () => {
  it("documents every color token globals.css declares, and no others", () => {
    expect(doc.color.tokens.map((t) => t.name).sort()).toEqual([...dark.color.keys()].sort());
  });

  it("has the same color values as globals.css in both themes", () => {
    for (const token of doc.color.tokens) {
      expect(inCode("color", token.name), token.name).toEqual(documented(token));
    }
  });

  it("has the same shadows as the elevation variables in both themes", () => {
    for (const token of doc.shadow.tokens) {
      const name = token.name.replace(/^shadow-/, "");
      expect(inCode("elevation", name), token.name).toEqual(documented(token));
    }
  });
});
