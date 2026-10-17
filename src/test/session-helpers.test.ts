import { describe, it, expect } from "vitest";
import { folderNameOf, groupSessionsByWorkspace, mostRecentSessionId, nextSessionName, isAutoName, titleFromPrompt } from "../lib/session-helpers";
import type { SessionNode } from "../lib/session-helpers";
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

  const fork = (id: string, cwd: string, createdAt: number, parent: string) => ({
    ...session(id, cwd, createdAt),
    forkedFrom: parent,
  });
  const ids = (nodes: SessionNode[]): unknown[] =>
    nodes.map((n) => (n.children.length ? [n.session.id, ids(n.children)] : n.session.id));

  it("lists every workspace in its own order, even one without sessions", () => {
    const groups = groupSessionsByWorkspace(
      [{ name: "web", path: "/w/web" }, { name: "api", path: "/w/api" }],
      [session("old-api", "/w/api", 1), session("new-api", "/w/api", 5)],
    );

    expect(groups.map((g) => g.name)).toEqual(["web", "api"]);
    expect(groups[0].sessions).toEqual([]);
    expect(ids(groups[1].sessions)).toEqual(["new-api", "old-api"]);
  });

  it("adds folders that only sessions know, newest first, after the workspaces", () => {
    const groups = groupSessionsByWorkspace(
      [{ name: "web", path: "/w/web" }],
      [session("a", "/w/a", 1), session("b", "/w/b", 2)],
    );

    expect(groups.map((g) => g.path)).toEqual(["/w/web", "/w/b", "/w/a"]);
  });

  it("nests forks under the session they came from", () => {
    const groups = groupSessionsByWorkspace(
      [{ name: "api", path: "/w/api" }],
      [
        session("root", "/w/api", 1),
        fork("fork-a", "/w/api", 2, "root"),
        fork("fork-of-fork", "/w/api", 3, "fork-a"),
        fork("fork-b", "/w/api", 4, "root"),
        session("other", "/w/api", 5),
      ],
    );

    expect(ids(groups[0].sessions)).toEqual(["other", ["root", ["fork-b", ["fork-a", ["fork-of-fork"]]]]]);
  });

  it("shows a fork at the top level when its source is gone or in another folder", () => {
    const groups = groupSessionsByWorkspace(
      [{ name: "api", path: "/w/api" }],
      [fork("orphan", "/w/api", 2, "deleted"), session("elsewhere", "/w/web", 1), fork("moved", "/w/api", 3, "elsewhere")],
    );

    expect(ids(groups[0].sessions)).toEqual(["moved", "orphan"]);
  });

  it("still lists sessions whose fork links form a loop", () => {
    const groups = groupSessionsByWorkspace(
      [{ name: "api", path: "/w/api" }],
      [fork("a", "/w/api", 1, "b"), fork("b", "/w/api", 2, "a")],
    );

    expect(ids(groups[0].sessions)).toEqual([["b", ["a"]]]);
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

