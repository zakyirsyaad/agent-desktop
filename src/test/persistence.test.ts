import { describe, it, expect } from "vitest";
import { canonicalAgentId, dropTerminalSessions, normalizePersistedState } from "../lib/persistence";

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

  it("keeps the model picked last for each agent, dropping malformed picks", () => {
    const state = normalizePersistedState({
      agentOptions: {
        qwen: { modes: null, configOptions: [], preferredConfig: { model: "qwen3-max", bad: 3 } },
        codex: { modes: null, configOptions: [], preferredConfig: "nope" },
      },
    });

    expect(state.agentOptions?.["qwen-code"].preferredConfig).toEqual({ model: "qwen3-max" });
    expect(state.agentOptions?.["codex-acp"].preferredConfig).toBeUndefined();
  });
});

describe("normalizePersistedState - legacy agent ids", () => {
  it("rewrites legacy agent ids in sessions and the default agent", () => {
    const state = normalizePersistedState({
      settings: { defaultAgentId: "qwen" },
      sessions: [
        base,
        { ...base, id: "s-2", profileId: "qwen" },
        { ...base, id: "s-3", profileId: "codex" },
        { ...base, id: "s-4", profileId: "omp" },
      ],
    });

    expect(state.settings.defaultAgentId).toBe("qwen-code");
    expect(state.sessions.map((s) => s.profileId)).toEqual(["claude-acp", "qwen-code", "codex-acp", "omp"]);
  });

  it("moves legacy agentOptions keys, keeping the new key when both exist", () => {
    const options = (model: string) => ({ modes: null, configOptions: [], preferredConfig: { model } });

    const state = normalizePersistedState({
      agentOptions: { qwen: options("old"), "qwen-code": options("new"), "claude-code": options("claude") },
    });

    expect(Object.keys(state.agentOptions ?? {}).sort()).toEqual(["claude-acp", "qwen-code"]);
    expect(state.agentOptions?.["qwen-code"].preferredConfig).toEqual({ model: "new" });
    expect(state.agentOptions?.["claude-acp"].preferredConfig).toEqual({ model: "claude" });
  });

  it("canonicalAgentId leaves unknown and current ids alone", () => {
    expect(canonicalAgentId("claude-code")).toBe("claude-acp");
    expect(canonicalAgentId("claude-acp")).toBe("claude-acp");
    expect(canonicalAgentId("aider")).toBe("aider");
  });
});

describe("normalizePersistedState - catalog settings", () => {
  it("keeps the new settings fields and defaults them when missing", () => {
    const empty = normalizePersistedState({ settings: {} }).settings;
    expect(empty.enabledAgents).toBeUndefined();
    expect(empty.removedAgents).toEqual([]);
    expect(empty.agentVersions).toEqual({});

    const { settings } = normalizePersistedState({
      settings: { enabledAgents: ["gemini"], removedAgents: ["goose"], agentVersions: { "codex-acp": "1.2.0" } },
    });
    expect(settings.enabledAgents).toEqual(["gemini"]);
    expect(settings.removedAgents).toEqual(["goose"]);
    expect(settings.agentVersions).toEqual({ "codex-acp": "1.2.0" });
  });

  it("rewrites legacy ids inside the lists and version keys, deduplicating with the new key winning", () => {
    const { settings } = normalizePersistedState({
      settings: {
        enabledAgents: ["claude-code", "claude-acp", "qwen", "gemini"],
        removedAgents: ["codex", "codex-acp"],
        agentVersions: { qwen: "0.1.0", "qwen-code": "0.2.0", codex: "1.0.0" },
      },
    });

    expect(settings.enabledAgents).toEqual(["claude-acp", "qwen-code", "gemini"]);
    expect(settings.removedAgents).toEqual(["codex-acp"]);
    expect(settings.agentVersions).toEqual({ "qwen-code": "0.2.0", "codex-acp": "1.0.0" });
  });

  it("drops malformed settings values", () => {
    const { settings } = normalizePersistedState({
      settings: { enabledAgents: "omp", removedAgents: ["aider", 3], agentVersions: { a: "1", b: 2 } },
    });

    expect(settings.enabledAgents).toBeUndefined();
    expect(settings.removedAgents).toEqual([]);
    expect(settings.agentVersions).toEqual({});
  });
});

describe("normalizePersistedState - notified updates", () => {
  it("keeps string pairs and drops non-string values", () => {
    const { settings } = normalizePersistedState({
      settings: { notifiedUpdates: { "claude-code": "1.1.0", "codex-acp": 2 } },
    });
    expect(settings.notifiedUpdates).toEqual({ "claude-acp": "1.1.0" });
  });

  it("defaults to none when missing or malformed", () => {
    expect(normalizePersistedState({ settings: {} }).settings.notifiedUpdates).toEqual({});
    expect(normalizePersistedState({ settings: { notifiedUpdates: ["x"] } }).settings.notifiedUpdates).toEqual({});
  });
});

describe("normalizePersistedState — appearance", () => {
  it("defaults a missing appearance to system", () => {
    expect(normalizePersistedState({ settings: {} }).settings.appearance).toBe("system");
  });

  it.each(["light", "dark"])("keeps %s", (appearance) => {
    expect(normalizePersistedState({ settings: { appearance } }).settings.appearance).toBe(appearance);
  });

  it.each(["sepia", 42])("treats %j as system", (appearance) => {
    expect(normalizePersistedState({ settings: { appearance } }).settings.appearance).toBe("system");
  });
});

describe("dropTerminalSessions", () => {
  const session = (overrides: Record<string, unknown>) => ({ ...base, ...overrides });

  it("drops pty and transport-less sessions and keeps acp ones", () => {
    const state = normalizePersistedState({
      sessions: [
        session({ id: "a", transport: "acp" }),
        session({ id: "p", transport: "pty" }),
        session({ id: "old" }), // saved before ACP: no transport
      ],
    });

    const { state: cleaned, droppedSessionIds } = dropTerminalSessions(state);

    expect(cleaned.sessions.map((s) => s.id)).toEqual(["a"]);
    expect(droppedSessionIds).toEqual(["p", "old"]);
  });

  it("returns the same state when there is no terminal session", () => {
    const state = normalizePersistedState({ sessions: [session({ id: "a", transport: "acp" })] });

    expect(dropTerminalSessions(state)).toEqual({ state, droppedSessionIds: [] });
    expect(dropTerminalSessions(state).state).toBe(state);
  });
});

describe("normalizePersistedState - removed agents", () => {
  it("cleans omp and aider out of the settings and agent options", () => {
    const state = normalizePersistedState({
      version: 1,
      settings: {
        defaultAgentId: "omp",
        enabledAgents: ["omp", "claude-acp", "aider"],
        removedAgents: ["aider", "gemini"],
        agentVersions: { omp: "1.0.0", "claude-acp": "0.5.0" },
      },
      agentOptions: { omp: { preferredConfig: { model: "opus" } }, "claude-acp": {} },
    });

    expect(state.version).toBe(2);
    expect(state.settings.defaultAgentId).toBeNull();
    expect(state.settings.enabledAgents).toEqual(["claude-acp"]);
    expect(state.settings.removedAgents).toEqual(["gemini"]);
    expect(state.settings.agentVersions).toEqual({ "claude-acp": "0.5.0" });
    expect(Object.keys(state.agentOptions ?? {})).toEqual(["claude-acp"]);
  });
});
