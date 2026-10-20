import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "../../site/app/page";
import robots from "../../site/app/robots";
import sitemap from "../../site/app/sitemap";
import { OG_COLORS } from "../../site/lib/og-colors";
import { siteUrl } from "../../site/lib/site";

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

  it("draws the Open Graph image in the dark theme's colors", () => {
    for (const [name, value] of Object.entries(OG_COLORS)) {
      expect(site.darkColor.get(name), name).toBe(value);
    }
  });

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
    for (const agent of ["Claude Code", "Codex", "Qwen Code", "Aider", "Oh-My-Pi"]) {
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

describe("search engines", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to build for production without an address, rather than publish localhost links", () => {
    expect(() => siteUrl({ NODE_ENV: "production" })).toThrow(/SITE_URL/);
    expect(siteUrl({ NODE_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "zorvo.xyz" }).href).toBe("https://zorvo.xyz/");
  });

  it("keeps a sub-path in SITE_URL for the sitemap", () => {
    vi.stubEnv("SITE_URL", "https://example.github.io/zorvo");
    expect(siteUrl().href).toBe("https://example.github.io/zorvo/");
    expect(robots().sitemap).toBe("https://example.github.io/zorvo/sitemap.xml");
    expect(sitemap()[0].url).toBe("https://example.github.io/zorvo/");
  });

  it("takes the site's address from SITE_URL, then Vercel's production domain, then localhost", () => {
    expect(siteUrl({ SITE_URL: "https://zorvo.xyz", VERCEL_PROJECT_PRODUCTION_URL: "zorvo.vercel.app" }).href).toBe(
      "https://zorvo.xyz/",
    );
    expect(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: "zorvo.vercel.app" }).href).toBe("https://zorvo.vercel.app/");
    expect(siteUrl({}).href).toBe("http://localhost:3100/");
  });

  it("lets crawlers in and points them at a sitemap of the page", () => {
    const base = siteUrl().href;
    expect(robots()).toMatchObject({ rules: { userAgent: "*", allow: "/" }, sitemap: `${base}sitemap.xml` });
    expect(sitemap().map((entry) => entry.url)).toEqual([base]);
  });

  it("describes Zorvo as a free macOS app in structured data", () => {
    const html = renderToStaticMarkup(<Home />);
    const json = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector('script[type="application/ld+json"]')?.textContent;
    expect(JSON.parse(json ?? "null")).toMatchObject({
      "@type": "SoftwareApplication",
      name: "Zorvo",
      operatingSystem: "macOS",
      offers: { price: "0" },
    });
  });
});
