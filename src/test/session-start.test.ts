import { describe, it, expect } from "vitest";
import { isWaitingForAnswer, newSessionRecord } from "../lib/session-start";
import { TRANSPORT_ACP, type AgentProfile, type ChatMessage, type Session } from "../types";

const QWEN = { id: "qwen", transport: TRANSPORT_ACP } as AgentProfile;

describe("newSessionRecord", () => {
  it("records a running session with the spec's agent, folder, flags and fork source", () => {
    const worktree = { repoPath: "/w/api", path: "/data/worktrees/api/fix", branch: "agent/fix" };

    const session = newSessionRecord(
      {
        id: "s-1",
        agent: QWEN,
        cwd: "/data/worktrees/api/fix",
        name: "Fix it",
        options: { model: "opus", effort: "high", permissionMode: "default", agentSessionId: "a-1" },
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
      model: "opus",
      effort: "high",
      permissionMode: "default",
      agentSessionId: "a-1",
      forkedFrom: "s-0",
      transport: TRANSPORT_ACP,
      worktree,
    });
  });

  it("makes up an id, and leaves out what the spec does not give", () => {
    const session = newSessionRecord({ agent: QWEN, cwd: "/w/api", name: "Session #1" }, 1);

    expect(session.id).toMatch(/^s-/);
    expect(session).toMatchObject({ agentSessionId: null, forkedFrom: null, worktree: null, model: undefined });
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
    expect(isWaitingForAnswer(acp, pending, true)).toBe(true);
    expect(isWaitingForAnswer(acp, pending, false)).toBe(false);
    expect(isWaitingForAnswer(acp, [], true)).toBe(false);
  });

  it("waits on a terminal agent with an unanswered approval card, though it has gone quiet", () => {
    const terminal = { status: "running", transport: "pty" } as Session;
    const typedPrompt: ChatMessage[] = [
      {
        id: "m-2",
        role: "agent",
        content: "",
        timestamp: 2,
        // A card from a [y/n] prompt in the terminal: there is no ACP request to answer.
        actionCard: { id: "c-2", sessionId: "s-2", title: "Run it?", prompt: "Run it? [y/n]", status: "pending" },
      } as ChatMessage,
    ];

    expect(isWaitingForAnswer(terminal, typedPrompt, false)).toBe(true);
    expect(isWaitingForAnswer({ ...acp, status: "running" }, typedPrompt, true)).toBe(false);
  });

  it("waits on nothing in a session that is not running", () => {
    expect(isWaitingForAnswer({ ...acp, status: "terminated" }, pending, true)).toBe(false);
    expect(isWaitingForAnswer(undefined, pending, true)).toBe(false);
  });
});
