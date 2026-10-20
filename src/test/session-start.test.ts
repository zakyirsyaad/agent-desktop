import { describe, it, expect, vi } from "vitest";
import { isWaitingForAnswer, newSessionRecord } from "../lib/session-start";
import { TRANSPORT_ACP, type AgentProfile, type ChatMessage, type Session } from "../types";

const QWEN = { id: "qwen" } as AgentProfile;

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
    });
  });

  it("makes up an id, and leaves out what the spec does not give", () => {
    const session = newSessionRecord({ agent: QWEN, cwd: "/w/api", name: "Session #1" }, 1);

    expect(session.id).toMatch(/^s-/);
    expect(session).toMatchObject({ forkedFrom: null, worktree: null });
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
