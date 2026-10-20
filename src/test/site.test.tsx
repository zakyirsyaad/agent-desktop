import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "../../site/app/page";

const ROOT = join(__dirname, "..", "..");
const appCss = readFileSync(join(ROOT, "src", "styles", "globals.css"), "utf8");
const siteCss = readFileSync(join(ROOT, "site", "app", "globals.css"), "utf8");

/** The text between the braces that follow `opener`, or "". */
function blockAfter(css: string, opener: string): string {
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
      .map(([, name, value]) => [name, value.replace(/\s+/g, "")]),
  );
}

function themes(css: string) {
  const light = blockAfter(css, "@media (prefers-color-scheme: light)");
  return {
    darkColor: declarations(blockAfter(css, "@theme"), "color"),
    darkElevation: declarations(blockAfter(css, ":root"), "elevation"),
    lightColor: declarations(light, "color"),
    lightElevation: declarations(light, "elevation"),
  };
}

describe("site tokens", () => {
  const app = themes(appCss);
  const site = themes(siteCss);

  it.each(["darkColor", "darkElevation", "lightColor", "lightElevation"] as const)(
    "match the app's %s values",
    (key) => {
      expect(app[key].size).toBeGreaterThan(0);
      for (const [name, value] of app[key]) {
        expect(site[key].get(name), name).toBe(value);
      }
    },
  );

  it("adds only terminal tokens of its own, which stay dark in both themes", () => {
    const extra = [...site.darkColor.keys()].filter((name) => !app.darkColor.has(name));
    expect(extra.every((name) => name.startsWith("terminal-"))).toBe(true);
    expect(extra.filter((name) => site.lightColor.has(name))).toEqual([]);
  });

  it("loads no web fonts from a CDN", () => {
    expect(siteCss).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@import\s+url\(/);
  });
});

describe("landing page", () => {
  const html = renderToStaticMarkup(<Home />);
  const document = new DOMParser().parseFromString(html, "text/html");
  const text = document.body.textContent ?? "";
  // The page's own words, without the code and chat inside its pictures of the app.
  const copy = (() => {
    const body = document.body.cloneNode(true) as HTMLElement;
    body.querySelectorAll('[role="img"]').forEach((picture) => picture.remove());
    return body.textContent ?? "";
  })();

  it("has the six approved sections in order, and no pricing", () => {
    const ids = [...document.querySelectorAll("main > section[id], main > div > section[id]")].map(
      (section) => section.id,
    );
    expect(ids).toEqual(["top", "agents", "features", "control", "privacy", "download"]);
    expect(text).not.toMatch(/pricing|per month|\$\d+\s*\/\s*mo/i);
  });

  it("has one h1, and every section is labelled by its heading", () => {
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    for (const section of document.querySelectorAll("section")) {
      const label = section.getAttribute("aria-labelledby");
      expect(label && document.getElementById(label)?.textContent, section.id).toBeTruthy();
    }
  });

  it("follows the copy rules: no exclamation marks, emoji or banned words", () => {
    expect(copy).not.toContain("!");
    expect(text).not.toMatch(/\p{Emoji_Presentation}/u);
    expect(copy).not.toMatch(/\b(seamless(ly)?|unlock|empower|simply|AI-powered)\b/i);
  });

  it("names every agent and says it is not endorsed by them", () => {
    for (const agent of ["Claude Code", "Codex", "Qwen Code"]) {
      expect(text).toContain(agent);
    }
    expect(text).toContain("not endorsed by them");
  });

  it("gives every image alt text, and every picture a description", () => {
    for (const image of document.querySelectorAll("img")) {
      expect(image.hasAttribute("alt")).toBe(true);
    }
    for (const picture of document.querySelectorAll('[role="img"]')) {
      expect(picture.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("keeps the pictures inert: no links or buttons inside them", () => {
    expect(document.querySelectorAll('[role="img"] :is(a, button, input, textarea, select)')).toHaveLength(0);
  });

  it("gives every link the focus ring and a real destination", () => {
    const links = [...document.querySelectorAll("a")];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const href = link.getAttribute("href") ?? "";
      expect(link.className, href).toContain("focus-ring");
      expect(href, link.textContent ?? "").toMatch(/^(#[a-z]+|https:\/\/github\.com\/zakyirsyaad\/zorvo\b)/);
    }
  });

  it("points every in-page link at an element that exists", () => {
    for (const link of document.querySelectorAll('a[href^="#"]')) {
      const id = link.getAttribute("href")!.slice(1);
      expect(document.getElementById(id), `#${id}`).not.toBeNull();
    }
  });
});
