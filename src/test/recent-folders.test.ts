import { describe, it, expect } from "vitest";
import {
  MAX_RECENT_FOLDERS,
  addRecentFolder,
  removeRecentFolder,
  type RecentFolder,
} from "../lib/recent-folders";

const NOW = 1_700_000_000_000;

/** Builds the Nth entry of a newest-first list, so a higher index is older. */
function folderAt(index: number): RecentFolder {
  return {
    name: `proj-${index}`,
    path: `/Users/test/proj-${index}`,
    lastOpenedAt: 100 - index,
  };
}

function fullList(): RecentFolder[] {
  return Array.from({ length: MAX_RECENT_FOLDERS }, (_unused, index) => folderAt(index));
}

describe("MAX_RECENT_FOLDERS", () => {
  it("keeps eight entries", () => {
    expect(MAX_RECENT_FOLDERS).toBe(8);
  });
});

describe("addRecentFolder", () => {
  it("stores the first folder with the timestamp it was given", () => {
    const result = addRecentFolder([], { name: "my-app", path: "/Users/test/my-app" }, NOW);

    expect(result).toEqual([
      { name: "my-app", path: "/Users/test/my-app", lastOpenedAt: NOW },
    ]);
  });

  it("puts a newly opened folder in front of the existing ones", () => {
    const list: RecentFolder[] = [
      { name: "alpha", path: "/Users/test/alpha", lastOpenedAt: 10 },
    ];

    const result = addRecentFolder(list, { name: "beta", path: "/Users/test/beta" }, NOW);

    expect(result.map((folder: RecentFolder) => folder.path)).toEqual([
      "/Users/test/beta",
      "/Users/test/alpha",
    ]);
  });

  it("moves a re-opened folder to the front and refreshes its name and timestamp", () => {
    const list: RecentFolder[] = [
      { name: "alpha", path: "/Users/test/alpha", lastOpenedAt: 10 },
      { name: "beta", path: "/Users/test/beta", lastOpenedAt: 9 },
    ];

    const result = addRecentFolder(
      list,
      { name: "beta-renamed", path: "/Users/test/beta" },
      NOW
    );

    expect(result).toEqual([
      { name: "beta-renamed", path: "/Users/test/beta", lastOpenedAt: NOW },
      { name: "alpha", path: "/Users/test/alpha", lastOpenedAt: 10 },
    ]);
  });

  it("drops the oldest entry once the list is full", () => {
    const oldest = folderAt(MAX_RECENT_FOLDERS - 1);

    const result = addRecentFolder(
      fullList(),
      { name: "newcomer", path: "/Users/test/newcomer" },
      NOW
    );

    expect(result).toHaveLength(MAX_RECENT_FOLDERS);
    expect(result[0]).toEqual({
      name: "newcomer",
      path: "/Users/test/newcomer",
      lastOpenedAt: NOW,
    });
    expect(result.at(-1)).toEqual(folderAt(MAX_RECENT_FOLDERS - 2));
    expect(result.some((folder: RecentFolder) => folder.path === oldest.path)).toBe(false);
  });

  it("leaves the input list untouched and returns a new array", () => {
    const frozen: readonly RecentFolder[] = Object.freeze([
      Object.freeze({ name: "alpha", path: "/Users/test/alpha", lastOpenedAt: 10 }),
    ]);

    const result = addRecentFolder(frozen, { name: "beta", path: "/Users/test/beta" }, NOW);

    expect(result).not.toBe(frozen);
    expect(frozen).toEqual([
      { name: "alpha", path: "/Users/test/alpha", lastOpenedAt: 10 },
    ]);
  });
});

describe("removeRecentFolder", () => {
  it("removes the folder matching the path", () => {
    const list: RecentFolder[] = [
      { name: "alpha", path: "/Users/test/alpha", lastOpenedAt: 10 },
      { name: "beta", path: "/Users/test/beta", lastOpenedAt: 9 },
    ];

    const result = removeRecentFolder(list, "/Users/test/alpha");

    expect(result).toEqual([
      { name: "beta", path: "/Users/test/beta", lastOpenedAt: 9 },
    ]);
  });

  it("returns an equal list when the path is unknown", () => {
    const list: RecentFolder[] = [
      { name: "alpha", path: "/Users/test/alpha", lastOpenedAt: 10 },
    ];

    const result = removeRecentFolder(list, "/Users/test/nowhere");

    expect(result).toEqual(list);
  });

  it("leaves the input list untouched and returns a new array", () => {
    const frozen: readonly RecentFolder[] = Object.freeze([
      Object.freeze({ name: "alpha", path: "/Users/test/alpha", lastOpenedAt: 10 }),
      Object.freeze({ name: "beta", path: "/Users/test/beta", lastOpenedAt: 9 }),
    ]);

    const result = removeRecentFolder(frozen, "/Users/test/alpha");

    expect(result).not.toBe(frozen);
    expect(result).toEqual([{ name: "beta", path: "/Users/test/beta", lastOpenedAt: 9 }]);
    expect(frozen).toHaveLength(2);
  });
});
