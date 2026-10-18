import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SYSTEM = join(ROOT, "docs", "design-system");
const COMPONENTS = join(SYSTEM, "components");
const css = readFileSync(join(ROOT, "src", "styles", "globals.css"), "utf8");

interface ThemedToken {
  name: string;
  value: string | { dark: string; light?: string };
}

interface TokensDoc {
  color: { tokens: ThemedToken[] };
  shadow: { tokens: ThemedToken[] };
  spacing: { tokens: ThemedToken[] };
  radius: { tokens: ThemedToken[] };
  size: { tokens: ThemedToken[] };
  type: { families: Record<string, string> };
}

const doc: TokensDoc = JSON.parse(readFileSync(join(SYSTEM, "tokens.json"), "utf8"));

const read = (...path: string[]) => readFileSync(join(...path), "utf8");
const componentDirs = readdirSync(COMPONENTS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/** Every CSS variable a preview can read: one per token, plus `--font-<family>`. */
const VARIABLES = new Set([
  ...[doc.color, doc.spacing, doc.radius, doc.shadow, doc.size].flatMap((f) => f.tokens.map((t) => t.name)),
  ...Object.keys(doc.type.families).map((family) => `font-${family}`),
]);

/** `var(--space-1\.5)` → "space-1.5". */
function variablesUsedIn(text: string): string[] {
  return [...text.matchAll(/var\(--([\w\\.-]+)\)/g)].map((m) => m[1].replace(/\\/g, ""));
}

/** The CSS a component brings: bundle.css and the `<style>` blocks inside previews. */
const componentCss = [
  read(COMPONENTS, "bundle.css"),
  ...componentDirs.flatMap((name) =>
    [...read(COMPONENTS, name, "preview.html").matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1])
  ),
].join("\n");

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

describe("docs/design-system components", () => {
  it("gives every component a preview, and every one but the cover a guideline", () => {
    for (const name of componentDirs) {
      const files = readdirSync(join(COMPONENTS, name));
      expect(files, name).toContain("preview.html");
      if (name !== "Cover") expect(files, name).toContain("README.md");
    }
  });

  it("styles previews only with variables tokens.json defines", () => {
    const unknown = variablesUsedIn(componentCss).filter((name) => !VARIABLES.has(name));
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("styles previews without raw colors", () => {
    expect(componentCss.match(/#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch)\(/g)).toBeNull();
  });

  it("finds variables written with an escaped dot", () => {
    expect(variablesUsedIn("gap: var(--space-1\\.5); color: var(--fg);")).toEqual(["space-1.5", "fg"]);
  });
});

describe("docs/design-system logos", () => {
  it("describes every logo file in the group's README", () => {
    const logos = join(SYSTEM, "assets", "Logos");
    const readme = read(logos, "README.md");
    const files = readdirSync(logos).filter((file) => file !== "README.md");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readme, file).toContain(file);
  });
});
