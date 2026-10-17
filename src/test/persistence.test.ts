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
});
