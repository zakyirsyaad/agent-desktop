import { describe, it, expect } from "vitest";
import { normalizePersistedState } from "../lib/persistence";

const base = { id: "s-1", name: "Fix login", profileId: "claude-code", cwd: "/w/api", status: "terminated", createdAt: 1 };

describe("normalizePersistedState", () => {
  it("keeps a session's worktree", () => {
    const worktree = { repoPath: "/w/api", path: "/data/worktrees/api/fix-login", branch: "agent/fix-login" };

    const state = normalizePersistedState({ sessions: [{ ...base, worktree }] });

    expect(state.sessions[0].worktree).toEqual(worktree);
  });

  it("drops a malformed worktree but keeps its session", () => {
    const state = normalizePersistedState({ sessions: [{ ...base, worktree: { path: 3 } }] });

    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].worktree).toBeUndefined();
  });

  it("drops malformed pin, archive and naming fields but keeps the session", () => {
    const state = normalizePersistedState({
      sessions: [{ ...base, pinned: "yes", archivedAt: "2026-10-17", namedByUser: 1, hasUnread: "no" }],
    });

    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).not.toHaveProperty("pinned");
    expect(state.sessions[0]).not.toHaveProperty("archivedAt");
    expect(state.sessions[0]).not.toHaveProperty("namedByUser");
    expect(state.sessions[0]).not.toHaveProperty("hasUnread");
  });
});
