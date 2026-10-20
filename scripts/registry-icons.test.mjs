import { describe, expect, it } from "vitest";
import { bundleIcons, isAllowedIconUrl, isSvg } from "./registry-icons.mjs";

const CDN = "https://cdn.agentclientprotocol.com/registry/v1/latest";

describe("isAllowedIconUrl", () => {
  it("allows only https URLs on the registry CDN", () => {
    expect(isAllowedIconUrl(`${CDN}/a.svg`)).toBe(true);
    expect(isAllowedIconUrl("http://cdn.agentclientprotocol.com/a.svg")).toBe(false);
    expect(isAllowedIconUrl("https://evil.example/a.svg")).toBe(false);
    expect(isAllowedIconUrl("https://cdn.agentclientprotocol.com.evil.example/a.svg")).toBe(false);
  });
});

describe("isSvg", () => {
  it("accepts SVG, with or without an XML prolog", () => {
    expect(isSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe(true);
    expect(isSvg('  <?xml version="1.0"?>\n<svg></svg>')).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isSvg("<html>")).toBe(false);
    expect(isSvg("\u0089PNG")).toBe(false);
    expect(isSvg("")).toBe(false);
  });

  it("rejects a leading comment, as the Rust check does", () => {
    expect(isSvg("<!-- logo --><svg></svg>")).toBe(false);
    expect(isSvg('<?xml version="1.0"?><!-- logo --><svg></svg>')).toBe(false);
  });

  it("accepts a self-closing <svg/ tag, as the Rust check does", () => {
    expect(isSvg("<svg/>")).toBe(true);
    expect(isSvg("<svgx>")).toBe(false);
  });
});

describe("bundleIcons", () => {
  it("keeps only valid icons and sorts the keys", async () => {
    const svg = "<svg></svg>";
    const bodies = {
      [`${CDN}/b.svg`]: svg,
      [`${CDN}/a.svg`]: svg,
      [`${CDN}/html.svg`]: "<html>",
      [`${CDN}/big.svg`]: `<svg>${"x".repeat(70 * 1024)}</svg>`,
    };
    const entries = [
      { id: "b", icon: `${CDN}/b.svg` },
      { id: "a", icon: `${CDN}/a.svg` },
      { id: "html", icon: `${CDN}/html.svg` },
      { id: "big", icon: `${CDN}/big.svg` },
      { id: "evil", icon: "https://evil.example/e.svg" },
      { id: "none" },
    ];
    const fetched = [];
    const bundle = await bundleIcons(entries, async (url) => {
      fetched.push(url);
      return bodies[url];
    });
    expect(Object.keys(bundle)).toEqual(["a", "b"]);
    expect(fetched).not.toContain("https://evil.example/e.svg");
  });

  it("skips an icon whose download fails when nothing was bundled before", async () => {
    const entries = [{ id: "a", icon: `${CDN}/a.svg` }];
    const bundle = await bundleIcons(entries, async () => {
      throw new Error("offline");
    });
    expect(bundle).toEqual({});
  });

  it("keeps the previous copy of a still-listed icon whose download fails or is invalid", async () => {
    const old = "<svg id='old'></svg>";
    const fresh = "<svg id='fresh'></svg>";
    const entries = [
      { id: "a", icon: `${CDN}/a.svg` },
      { id: "b", icon: `${CDN}/b.svg` },
      { id: "c", icon: `${CDN}/c.svg` },
    ];
    const previous = { a: old, b: old, c: old, gone: old };
    const bundle = await bundleIcons(
      entries,
      async (url) => {
        if (url.endsWith("a.svg")) throw new Error("offline");
        if (url.endsWith("b.svg")) return "<html>";
        return fresh;
      },
      previous,
    );
    expect(bundle).toEqual({ a: old, b: old, c: fresh });
  });
});
