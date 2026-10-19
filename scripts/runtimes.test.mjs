import { describe, expect, it } from "vitest";
import { isOldEnough, parseShasums, pickNodeRelease, pickUvRelease } from "./runtimes.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-19T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();
const dateOnly = (n) => daysAgo(n).slice(0, 10);

describe("isOldEnough", () => {
  it("accepts exactly seven days and rejects six", () => {
    expect(isOldEnough(daysAgo(7), NOW)).toBe(true);
    expect(isOldEnough(daysAgo(6), NOW)).toBe(false);
  });

  it("rejects an unparseable date", () => {
    expect(isOldEnough("soon", NOW)).toBe(false);
  });
});

describe("pickNodeRelease", () => {
  it("returns the newest LTS at least seven days old", () => {
    const index = [
      { version: "v25.1.0", date: dateOnly(30), lts: false },
      { version: "v24.12.0", date: dateOnly(6), lts: "Krypton" },
      { version: "v24.11.1", date: dateOnly(10), lts: "Krypton" },
      { version: "v22.20.0", date: dateOnly(60), lts: "Jod" },
    ];
    expect(pickNodeRelease(index, NOW)).toEqual({ version: "24.11.1", released: dateOnly(10) });
  });

  it("prefers the highest LTS line over an older line's later patch", () => {
    const index = [
      { version: "v22.23.3", date: dateOnly(10), lts: "Jod" },
      { version: "v24.21.0", date: dateOnly(40), lts: "Krypton" },
    ];
    expect(pickNodeRelease(index, NOW).version).toBe("24.21.0");
  });

  it("returns null when nothing qualifies", () => {
    expect(pickNodeRelease([{ version: "v24.12.0", date: dateOnly(1), lts: "Krypton" }], NOW)).toBeNull();
  });
});

describe("pickUvRelease", () => {
  it("skips drafts, prereleases and a release from six days ago", () => {
    const releases = [
      { tag_name: "0.9.5", published_at: daysAgo(6), draft: false, prerelease: false },
      { tag_name: "0.9.4", published_at: daysAgo(20), draft: true, prerelease: false },
      { tag_name: "0.9.3", published_at: daysAgo(20), draft: false, prerelease: true },
      { tag_name: "0.9.2", published_at: daysAgo(12), draft: false, prerelease: false },
    ];
    expect(pickUvRelease(releases, NOW)).toEqual({ version: "0.9.2", released: dateOnly(12) });
  });
});

describe("parseShasums", () => {
  const hash = "a".repeat(64);
  const text = `${hash}  node-v24.11.1-darwin-arm64.tar.gz\n${"b".repeat(64)}  node-v24.11.1-darwin-x64.tar.gz\n`;

  it("finds the hash for a file", () => {
    expect(parseShasums(text, "node-v24.11.1-darwin-arm64.tar.gz")).toBe(hash);
  });

  it("returns null for a missing file", () => {
    expect(parseShasums(text, "node-v24.11.1-linux-x64.tar.gz")).toBeNull();
  });
});
