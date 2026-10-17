import { describe, it, expect } from "vitest";
import { folderNameOf, groupSessionsByFolder, mostRecentSessionId, nextSessionName, isAutoName, titleFromPrompt } from "../lib/session-helpers";
import type { Session } from "../types";

function session(id: string, cwd: string, createdAt: number): Session {
  return { id, name: id, profileId: "claude-code", cwd, status: "terminated", createdAt };
}

describe("session helpers", () => {
  it("takes the last path segment as the folder name", () => {
    expect(folderNameOf("/Users/a/project/")).toBe("project");
    expect(folderNameOf("/Users/a/my app")).toBe("my app");
  });

  it("returns the most recent session id, or empty without sessions", () => {
    expect(mostRecentSessionId([session("a", "/x", 1), session("b", "/x", 5)])).toBe("b");
    expect(mostRecentSessionId([])).toBe("");
  });

  it("groups sessions by folder with the active folder first and newest sessions first", () => {
    const groups = groupSessionsByFolder(
      [session("old-api", "/w/api", 1), session("web", "/w/web", 9), session("new-api", "/w/api", 5)],
      "/w/api",
    );

    expect(groups.map((g) => g.name)).toEqual(["api", "web"]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["new-api", "old-api"]);
  });

  it("orders inactive folders by their most recent session", () => {
    const groups = groupSessionsByFolder([session("a", "/w/a", 1), session("b", "/w/b", 2)], undefined);

    expect(groups.map((g) => g.name)).toEqual(["b", "a"]);
  });
});

describe("nextSessionName", () => {
  const named = (name: string) => ({ name }) as Session;

  it("numbers sessions after the highest existing number, so names never repeat after a delete", () => {
    expect(nextSessionName([])).toBe("Session #1");
    expect(nextSessionName([named("Session #1"), named("Session #3")])).toBe("Session #4");
    expect(nextSessionName([named("Fix login"), named("Session #2 (fork)")])).toBe("Session #3");
  });
});

describe("titleFromPrompt", () => {
  it("uses the first line of the prompt, tidied up", () => {
    expect(titleFromPrompt("  fix the   login bug\nand add a test")).toBe("fix the login bug");
  });

  it("cuts a long prompt at a word boundary", () => {
    const title = titleFromPrompt("refactor the stream parser so that it handles partial escape sequences across chunks");

    expect(title).toBe("refactor the stream parser so that it handles…");
    expect(title.length).toBeLessThanOrEqual(49);
  });

  it("falls back when the prompt has no text", () => {
    expect(titleFromPrompt("   \n ")).toBe("New session");
  });
});

describe("isAutoName", () => {
  it("tells numbered placeholder names from real titles", () => {
    expect(isAutoName("Session #12")).toBe(true);
    expect(isAutoName("fix the login bug")).toBe(false);
    expect(isAutoName("Session #2 (fork)")).toBe(false);
  });
});

