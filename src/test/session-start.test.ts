import { describe, it, expect, vi } from "vitest";
import { importedSessionSpec, isWaitingForAnswer, newSessionRecord } from "../lib/session-start";
import type { ListedSession } from "../lib/session-list";
import { TRANSPORT_ACP, type AgentProfile, type ChatMessage, type Session } from "../types";

const QWEN = { id: "qwen" } as AgentProfile;
const CLAUDE = { id: "claude-acp", name: "Claude Code" } as AgentProfile;

describe("newSessionRecord", () => {
  it("records a running session with the spec's agent, folder and fork source", () => {
    const worktree = { repoPath: "/w/api", path: "/data/worktrees/api/fix", branch: "agent/fix" };

    const session = newSessionRecord(
      {
        id: "s-1",
        agent: QWEN,
        cwd: "/data/worktrees/api/fix",
        name: "Fix it",
        forkedFrom: "s-0",
        worktree,
      },
      1234,
    );

    expect(session).toEqual({
      id: "s-1",
      name: "Fix it",
      profileId: "qwen",
      cwd: "/data/worktrees/api/fix",
      status: "running",
      createdAt: 1234,
      forkedFrom: "s-0",
      transport: TRANSPORT_ACP,
      worktree,
      acpSessionId: null,
    });
  });

  it("makes up an id, and leaves out what the spec does not give", () => {
    const session = newSessionRecord({ agent: QWEN, cwd: "/w/api", name: "Session #1" }, 1);

    expect(session.id).toMatch(/^s-/);
    expect(session).toMatchObject({ forkedFrom: null, worktree: null, acpSessionId: null });
  });

  it("records the agent session an import reopens", () => {
    const session = newSessionRecord(
      { agent: QWEN, cwd: "/w/api", name: "Imported", acpSessionId: "acp-listed" },
      1,
    );

    expect(session.acpSessionId).toBe("acp-listed");
  });
});

describe("importedSessionSpec", () => {
  const listed = (title: string | undefined, updatedAt: string | undefined = "2026-10-20T08:00:00Z"): ListedSession => ({
    acpSessionId: "acp-listed",
    ...(title === undefined ? {} : { title }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  });

  it("names the session after its title in the agent's list", () => {
    const spec = importedSessionSpec(listed("Fix the login bug"), CLAUDE, "/w/zorvo", 1);

    expect(spec).toEqual({
      agent: CLAUDE,
      cwd: "/w/zorvo",
      name: "Fix the login bug",
      acpSessionId: "acp-listed",
    });
  });

  it("carries the agent session id to reopen", () => {
    expect(importedSessionSpec(listed("Fix the login bug"), CLAUDE, "/w/zorvo", 1).acpSessionId).toBe("acp-listed");
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "  \n\t "],
  ])("names the session for the agent and date when its title is %s", (_case, title) => {
    expect(importedSessionSpec(listed(title), CLAUDE, "/w/zorvo", 1).name).toBe("Claude Code session, 20 Oct");
  });

  it("names the session for the agent and date when it has no title", () => {
    expect(importedSessionSpec(listed(undefined), CLAUDE, "/w/zorvo", 1).name).toBe(
      "Claude Code session, 20 Oct",
    );
  });

  it("uses the date the session was last updated", () => {
    expect(importedSessionSpec(listed(undefined, "2026-10-18T08:00:00Z"), CLAUDE, "/w/zorvo", 1).name).toBe(
      "Claude Code session, 18 Oct",
    );
  });

  it("dates a session the list left undated by the import time", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");

    expect(importedSessionSpec(listed(undefined, undefined), CLAUDE, "/w/zorvo", now).name).toBe(
      "Claude Code session, 20 Oct",
    );
  });

  it("keeps a multi-line markdown title on one line", () => {
    const spec = importedSessionSpec(
      listed("# Fix the login\n\nSome **details**\nand more"),
      CLAUDE,
      "/w/zorvo",
      1,
    );

    expect(spec.name).toBe("# Fix the login");
    expect(spec.name).not.toContain("\n");
  });
});

describe("isWaitingForAnswer", () => {
  const pending: ChatMessage[] = [
    {
      id: "m-1",
      role: "agent",
      content: "",
      timestamp: 1,
      actionCard: { id: "c-1", sessionId: "s-1", title: "Run it?", prompt: "Run it?", status: "pending", requestId: 7 },
    } as ChatMessage,
  ];
  const acp = { status: "running", transport: TRANSPORT_ACP } as Session;

  it("waits on an ACP agent that is still busy with an unanswered request", () => {
    expect(isWaitingForAnswer(acp, pending, () => true)).toBe(true);
    expect(isWaitingForAnswer(acp, pending, () => false)).toBe(false);
    expect(isWaitingForAnswer(acp, [], () => true)).toBe(false);
  });

  it("waits on an elicitation even between turns", () => {
    const asking = [
      {
        id: "m-2",
        role: "agent",
        content: "",
        timestamp: 2,
        elicitation: { key: "el-1", sessionId: "s-1", mode: "form", message: "Name?", status: "pending", timestamp: 2 },
      } as ChatMessage,
    ];
    expect(isWaitingForAnswer(acp, asking, () => false)).toBe(true);
    expect(isWaitingForAnswer({ ...acp, status: "terminated" }, asking, () => false)).toBe(false);
  });

  it("asks whether the agent is busy only for a running session", () => {
    const isBusy = vi.fn(() => true);

    isWaitingForAnswer({ ...acp, status: "terminated" }, pending, isBusy);
    expect(isBusy).not.toHaveBeenCalled();
    isWaitingForAnswer(acp, pending, isBusy);
    expect(isBusy).toHaveBeenCalledTimes(1);
  });

  it("waits on nothing in a session that is not running", () => {
    expect(isWaitingForAnswer({ ...acp, status: "terminated" }, pending, () => true)).toBe(false);
    expect(isWaitingForAnswer(undefined, pending, () => true)).toBe(false);
  });
});
