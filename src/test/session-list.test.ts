import { describe, it, expect } from "vitest";
import { sessionsToOffer, toListedSessions, type ListedSession } from "../lib/session-list";
import type { Session } from "../types";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s-1",
    name: "A session",
    profileId: "qwen",
    cwd: "/Users/test/developer/zorvo",
    status: "terminated",
    createdAt: 1,
    transport: "acp",
    ...overrides,
  };
}

describe("toListedSessions", () => {
  it("keeps the sessions the agent listed and drops malformed entries", () => {
    const listed = toListedSessions({
      sessions: [
        { acpSessionId: "acp-1", title: "Fix the parser", updatedAt: "2026-10-20T09:00:00Z", cwd: "/w" },
        { acpSessionId: "acp-2" },
        { title: "No id" },
        { acpSessionId: 7, title: "Wrong id" },
        null,
        "not a session",
      ],
      truncated: true,
      incomplete: false,
    });

    expect(listed).toEqual({
      sessions: [
        { acpSessionId: "acp-1", title: "Fix the parser", updatedAt: "2026-10-20T09:00:00Z" },
        { acpSessionId: "acp-2" },
      ],
      truncated: true,
      incomplete: false,
    });
  });

  it("defaults truncated and incomplete when they are missing or not booleans", () => {
    expect(toListedSessions({ sessions: [] })).toEqual({ sessions: [], truncated: false, incomplete: false });
    expect(toListedSessions({ sessions: [], truncated: "yes", incomplete: 1 })).toEqual({
      sessions: [],
      truncated: false,
      incomplete: false,
    });
  });

  it("does not throw on an answer that is not a list", () => {
    for (const raw of [null, undefined, {}, { sessions: "nope" }, []]) {
      expect(toListedSessions(raw)).toEqual({ sessions: [], truncated: false, incomplete: false });
    }
  });
});

describe("sessionsToOffer", () => {
  const listed: ListedSession[] = [
    { acpSessionId: "acp-archived" },
    { acpSessionId: "acp-other-agent" },
    { acpSessionId: "acp-open" },
    { acpSessionId: "acp-undated-1" },
    { acpSessionId: "acp-older", updatedAt: "2026-10-19T18:00:00Z" },
    { acpSessionId: "acp-undated-2" },
    { acpSessionId: "acp-newest", updatedAt: "2026-10-20T09:00:00Z" },
  ];

  it("drops every id a Zorvo session already holds, archived ones and other agents included", () => {
    const sessions = [
      session({ id: "s-open", profileId: "qwen", acpSessionId: "acp-open" }),
      session({ id: "s-archived", profileId: "qwen", acpSessionId: "acp-archived", archivedAt: 5 }),
      session({ id: "s-claude", profileId: "claude-code", acpSessionId: "acp-other-agent" }),
      session({ id: "s-none", acpSessionId: null }),
    ];

    expect(sessionsToOffer(listed, sessions).map((entry) => entry.acpSessionId)).toEqual([
      "acp-newest",
      "acp-older",
      "acp-undated-1",
      "acp-undated-2",
    ]);
  });

  it("puts the newest updatedAt first and keeps undated entries last, in the agent's order", () => {
    expect(sessionsToOffer(listed, []).map((entry) => entry.acpSessionId)).toEqual([
      "acp-newest",
      "acp-older",
      "acp-archived",
      "acp-other-agent",
      "acp-open",
      "acp-undated-1",
      "acp-undated-2",
    ]);
  });
});