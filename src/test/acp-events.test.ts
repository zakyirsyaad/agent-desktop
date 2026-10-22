import { describe, it, expect } from "vitest";
import {
  applyAcpUpdate,
  applyPermissionRequest,
  applyReplayUpdate,
  closeImportedTurn,
  closeTurn,
  isAwaitingPermission,
  pendingCardsInTurn,
  resolvePermissionCard,
  type AcpReducerContext,
} from "../lib/acp-events";
import type { ChatMessage, ToolExecution } from "../types";

function ctx(): AcpReducerContext {
  let n = 0;
  return { sessionId: "s-1", now: 1000, createId: (prefix) => `${prefix}-${++n}` };
}

const text = (t: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });

describe("applyAcpUpdate", () => {
  it("ignores empty chunks, so a stray one after the turn does not start a blank reply", () => {
    const done = closeTurn(applyAcpUpdate([], text("ok"), ctx()));

    expect(applyAcpUpdate(done, text(""), ctx())).toBe(done);
    expect(
      applyAcpUpdate(done, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" } }, ctx())
    ).toBe(done);
  });

  it("streams agent text chunks into one reply", () => {
    const c = ctx();
    const afterFirst = applyAcpUpdate([], text("Hello "), c);
    const result = applyAcpUpdate(afterFirst, text("world"), c);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: "agent", content: "Hello world" });
  });

  it("starts a new reply after the user speaks and after a turn ended", () => {
    const c = ctx();
    const user: ChatMessage = { id: "u", role: "user", content: "hi", timestamp: 1 };
    const replied = applyAcpUpdate([user], text("first"), c);
    const closed = closeTurn(replied);

    const result = applyAcpUpdate(closed, text("second"), c);

    expect(result.map((m) => m.content)).toEqual(["hi", "first", "second"]);
    expect(closed[1].isComplete).toBe(true);
  });

  it("collects streamed thoughts separately from the reply", () => {
    const c = ctx();
    const thought = applyAcpUpdate(
      [],
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me check" } },
      c,
    );
    const result = applyAcpUpdate(thought, text("Done"), c);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ thinking: "Let me check", content: "Done" });
  });

  it("adds tool calls and updates their status by id", () => {
    const c = ctx();
    const started = applyAcpUpdate(
      [],
      { sessionUpdate: "tool_call", toolCallId: "t-1", title: "Read src/App.tsx", kind: "read", status: "pending" },
      c,
    );
    const finished = applyAcpUpdate(
      started,
      { sessionUpdate: "tool_call_update", toolCallId: "t-1", status: "completed" },
      c,
    );

    expect(started[0].tools).toMatchObject([
      { id: "t-1", name: "Read src/App.tsx", status: "running", kind: "read", startedAt: 1000 },
    ]);
    expect(finished[0].tools?.[0].status).toBe("completed");
  });

  it("marks a failed tool call as failed and keeps a retitled one", () => {
    const c = ctx();
    const started = applyAcpUpdate(
      [],
      { sessionUpdate: "tool_call", toolCallId: "t-1", title: "Run", kind: "execute", status: "in_progress" },
      c,
    );
    const result = applyAcpUpdate(
      started,
      { sessionUpdate: "tool_call_update", toolCallId: "t-1", status: "failed", title: "Run npm test" },
      c,
    );

    expect(result[0].tools?.[0]).toMatchObject({ status: "failed", name: "Run npm test" });
  });

  it("shows the latest plan on the current reply", () => {
    const c = ctx();
    const result = applyAcpUpdate(
      [],
      {
        sessionUpdate: "plan",
        entries: [
          { content: "Read the parser", status: "completed", priority: "high" },
          { content: "Split it", status: "in_progress", priority: "medium" },
        ],
      },
      c,
    );

    expect(result[0].plan?.map((e) => e.status)).toEqual(["completed", "in_progress"]);
  });

  it("ignores updates it does not render and malformed chunks", () => {
    const c = ctx();
    const messages: ChatMessage[] = [{ id: "u", role: "user", content: "hi", timestamp: 1 }];

    expect(applyAcpUpdate(messages, { sessionUpdate: "available_commands_update" }, c)).toBe(messages);
    expect(applyAcpUpdate(messages, { sessionUpdate: "agent_message_chunk", content: { type: "image" } }, c)).toBe(
      messages,
    );
    expect(applyAcpUpdate(messages, null, c)).toBe(messages);
  });
});

describe("reply parts", () => {
  const toolCall = (id: string, kind = "read", title = `Tool ${id}`) => ({
    sessionUpdate: "tool_call",
    toolCallId: id,
    title,
    kind,
    status: "pending",
  });

  it("keeps text and tools in the order they happened", () => {
    const c = ctx();
    let messages = applyAcpUpdate([], text("Let me look."), c);
    messages = applyAcpUpdate(messages, toolCall("t-1"), c);
    messages = applyAcpUpdate(messages, text("Found it."), c);
    messages = applyAcpUpdate(messages, toolCall("t-2"), c);

    expect(messages[0].parts).toEqual([
      { kind: "text", text: "Let me look." },
      { kind: "tools", toolIds: ["t-1"] },
      { kind: "text", text: "Found it." },
      { kind: "tools", toolIds: ["t-2"] },
    ]);
  });

  it("keeps two text chunks in a row as one text part", () => {
    const c = ctx();
    const messages = applyAcpUpdate(applyAcpUpdate([], text("Hello "), c), text("world"), c);

    expect(messages[0].parts).toEqual([{ kind: "text", text: "Hello world" }]);
  });

  it("keeps consecutive tool calls in one tools part", () => {
    const c = ctx();
    const once = applyAcpUpdate([], toolCall("t-1"), c);
    const messages = applyAcpUpdate(once, toolCall("t-2"), c);

    expect(messages[0].parts).toEqual([{ kind: "tools", toolIds: ["t-1", "t-2"] }]);
  });

  it("joins separate text parts with a blank line in content", () => {
    const c = ctx();
    let messages = applyAcpUpdate([], text("files"), c);
    messages = applyAcpUpdate(messages, toolCall("t-1"), c);
    messages = applyAcpUpdate(messages, text("Let me"), c);

    expect(messages[0].content).toBe("files\n\nLet me");
  });

  it("keeps the order in a replay", () => {
    const c = ctx();
    let messages = applyReplayUpdate([], userChunk("go", "m-1"), c);
    messages = applyReplayUpdate(messages, text("Reading."), c);
    messages = applyReplayUpdate(messages, toolCall("t-1"), c);
    messages = applyReplayUpdate(messages, text("Done."), c);

    expect(messages[1].parts).toEqual([
      { kind: "text", text: "Reading." },
      { kind: "tools", toolIds: ["t-1"] },
      { kind: "text", text: "Done." },
    ]);
    expect(messages[1].content).toBe("Reading.\n\nDone.");
  });
});

describe("tool call details", () => {
  const edit = {
    sessionUpdate: "tool_call",
    toolCallId: "t-7",
    title: "Edit src/app.ts",
    kind: "edit",
    status: "pending",
    locations: [{ path: "/repo/src/app.ts", line: 12 }],
    content: [{ type: "diff", path: "/repo/src/app.ts", oldText: "const a = 1;", newText: "const a = 2;" }],
  };

  it("keeps a tool's diffs, text output and file locations", () => {
    const result = applyAcpUpdate(
      [],
      {
        ...edit,
        content: [
          ...edit.content,
          { type: "content", content: { type: "text", text: "1 file changed" } },
          { type: "terminal", terminalId: "term-1" },
        ],
      },
      ctx()
    );

    expect(result[0].tools?.[0]).toMatchObject({
      details: [
        { kind: "diff", path: "/repo/src/app.ts", oldText: "const a = 1;", newText: "const a = 2;" },
        { kind: "text", text: "1 file changed" },
      ],
      locations: ["/repo/src/app.ts:12"],
    });
  });

  it("replaces the details when an update brings new content, and keeps them otherwise", () => {
    const c = ctx();
    const started = applyAcpUpdate([], edit, c);
    const withOutput = applyAcpUpdate(
      started,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t-7",
        content: [{ type: "content", content: { type: "text", text: "done" } }],
      },
      c
    );
    const finished = applyAcpUpdate(withOutput, { sessionUpdate: "tool_call_update", toolCallId: "t-7", status: "completed" }, c);

    expect(finished[0].tools?.[0].details).toEqual([{ kind: "text", text: "done" }]);
    expect(finished[0].tools?.[0].status).toBe("completed");
  });

  it("keeps only the end of very long output, and summarizes a file change too big to show", () => {
    const longOutput = "x".repeat(60_000) + "THE END";
    const hugeFile = "line\n".repeat(60_000);
    const result = applyAcpUpdate(
      [],
      {
        ...edit,
        content: [
          { type: "content", content: { type: "text", text: longOutput } },
          { type: "diff", path: "/repo/big.txt", oldText: null, newText: hugeFile },
        ],
      },
      ctx()
    );

    const [text, diff] = result[0].tools?.[0].details ?? [];
    expect(text.kind === "text" && text.text.startsWith("… earlier output not shown")).toBe(true);
    expect(text.kind === "text" && text.text.endsWith("THE END")).toBe(true);
    expect(text.kind === "text" && text.text.length).toBeLessThan(51_000);
    expect(diff).toEqual({ kind: "text", text: "Changed /repo/big.txt (too large to show)" });
  });

  it("treats a missing oldText as a new file", () => {
    const result = applyAcpUpdate(
      [],
      { ...edit, content: [{ type: "diff", path: "/repo/new.ts", oldText: null, newText: "export {};" }] },
      ctx()
    );

    expect(result[0].tools?.[0].details).toEqual([{ kind: "diff", path: "/repo/new.ts", oldText: null, newText: "export {};" }]);
  });
});

describe("permission requests", () => {
  const request = {
    requestId: "perm-1",
    toolCall: { toolCallId: "t-9", title: "Run rm -rf build", kind: "execute", rawInput: { command: "rm -rf build" } },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  };

  it("turns a permission request into an action card with the agent's own choices", () => {
    const result = applyPermissionRequest([], request, ctx());

    expect(result[0].actionCard).toMatchObject({
      sessionId: "s-1",
      prompt: "Run rm -rf build",
      toolName: "execute",
      commandSnippet: "rm -rf build",
      status: "pending",
      requestId: "perm-1",
    });
    expect(result[0].actionCard?.options?.map((o) => o.optionId)).toEqual(["allow", "reject"]);
  });

  it("records the chosen option and whether it allowed or rejected", () => {
    const withCard = applyPermissionRequest([], request, ctx());
    const cardId = withCard[0].actionCard!.id;

    const allowed = resolvePermissionCard(withCard, cardId, "allow");
    const rejected = resolvePermissionCard(withCard, cardId, "reject");

    expect(allowed[0].actionCard).toMatchObject({ status: "approved", chosenOptionId: "allow" });
    expect(rejected[0].actionCard).toMatchObject({ status: "rejected", chosenOptionId: "reject" });
  });

  it("starts a new reply for text that follows an answered card", () => {
    const c = ctx();
    const withCard = applyPermissionRequest([], request, c);
    const answered = resolvePermissionCard(withCard, withCard[0].actionCard!.id, "allow");

    const result = applyAcpUpdate(answered, text("Removed it."), c);

    expect(result).toHaveLength(2);
    expect(result[1].content).toBe("Removed it.");
  });

  it("closing a turn rejects a card that was never answered", () => {
    const withCard = applyPermissionRequest([], request, ctx());

    expect(closeTurn(withCard)[0].actionCard?.status).toBe("rejected");
  });

  it("keeps an earlier unanswered request when the agent asks again", () => {
    const c = ctx();
    const first = applyPermissionRequest([], request, c);
    const both = applyPermissionRequest(first, { ...request, requestId: "perm-2" }, c);

    expect(both.map((m) => m.actionCard?.requestId)).toEqual(["perm-1", "perm-2"]);
    expect(pendingCardsInTurn(both).map((card) => card.requestId)).toEqual(["perm-1", "perm-2"]);
  });

  it("closing a turn closes every unanswered request, not only the last one", () => {
    const c = ctx();
    const both = applyPermissionRequest(applyPermissionRequest([], request, c), { ...request, requestId: "perm-2" }, c);

    const closed = closeTurn(both);

    expect(closed.map((m) => m.actionCard?.status)).toEqual(["rejected", "rejected"]);
    expect(pendingCardsInTurn(closed)).toEqual([]);
  });

  it("finds only the current turn's unanswered cards", () => {
    const c = ctx();
    const earlier = applyPermissionRequest([], request, c);
    const user: ChatMessage = { id: "u-2", role: "user", content: "next", timestamp: 2 };
    const messages = applyPermissionRequest([...earlier, user], { ...request, requestId: "perm-2" }, c);

    expect(pendingCardsInTurn(messages).map((card) => card.requestId)).toEqual(["perm-2"]);
    expect(isAwaitingPermission(messages)).toBe(true);
    expect(isAwaitingPermission([...earlier, user])).toBe(false);
  });
});

describe("closeTurn", () => {
  const tool = (id: string, status: ToolExecution["status"]): ToolExecution => ({ id, name: id, status });
  const reply = (id: string, tools: ToolExecution[]): ChatMessage => ({
    id,
    role: "agent",
    content: "",
    timestamp: 1,
    tools,
  });

  it("leaves a running tool running, rejects an unanswered card and completes the last reply", () => {
    const messages: ChatMessage[] = [
      reply("a-1", [tool("t-done", "completed"), tool("t-running", "running")]),
      {
        ...reply("a-2", [tool("t-failed", "failed"), tool("t-running-2", "running")]),
        actionCard: {
          id: "act-1",
          sessionId: "s-1",
          title: "Permission requested",
          prompt: "Run the tests",
          status: "pending",
          timestamp: 1,
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          requestId: "perm-1",
        },
      },
    ];

    const closed = closeTurn(messages);

    expect(closed.flatMap((m) => m.tools?.map((t) => [t.id, t.status]) ?? [])).toEqual([
      ["t-done", "completed"],
      ["t-running", "running"],
      ["t-failed", "failed"],
      ["t-running-2", "running"],
    ]);
    expect(closed[0].isComplete).toBeUndefined();
    expect(closed[1].actionCard?.status).toBe("rejected");
    expect(closed[1].isComplete).toBe(true);
    expect(messages[0].tools?.map((t) => t.status)).toEqual(["completed", "running"]);
  });
});

describe("closeImportedTurn", () => {
  const tool = (id: string, status: ToolExecution["status"]): ToolExecution => ({ id, name: id, status });
  const reply = (id: string, tools: ToolExecution[]): ChatMessage => ({
    id,
    role: "agent",
    content: "",
    timestamp: 1,
    tools,
  });

  it("settles the last turn of a replay whose tool call and request never finished", () => {
    const c = ctx();
    let messages = applyReplayUpdate([], userChunk("run the tests", "m-1"), c);
    messages = applyReplayUpdate(
      messages,
      { sessionUpdate: "tool_call", toolCallId: "t-1", title: "pnpm test", status: "in_progress" },
      c,
    );
    messages = applyPermissionRequest(
      messages,
      {
        requestId: "perm-1",
        toolCall: { toolCallId: "t-1", title: "Run the tests", kind: "execute" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
      c,
    );

    const closed = closeImportedTurn(messages);
    const last = closed[closed.length - 1];

    expect(last.isComplete).toBe(true);
    expect(last.actionCard?.status).toBe("rejected");
    expect(last.tools?.map((t) => t.status)).toEqual(["failed"]);
    expect(pendingCardsInTurn(closed)).toEqual([]);
    expect(messages[messages.length - 1].tools?.map((t) => t.status)).toEqual(["running"]);
  });

  it("settles running tools as failed and leaves settled ones alone", () => {
    const messages = [
      reply("a-1", [tool("t-done", "completed"), tool("t-running", "running")]),
      reply("a-2", [tool("t-failed", "failed"), tool("t-running-2", "running")]),
    ];

    const closed = closeImportedTurn(messages);

    expect(closed.flatMap((m) => m.tools?.map((t) => [t.id, t.status]) ?? [])).toEqual([
      ["t-done", "completed"],
      ["t-running", "failed"],
      ["t-failed", "failed"],
      ["t-running-2", "failed"],
    ]);
    expect(messages[0].tools?.map((t) => t.status)).toEqual(["completed", "running"]);
  });
});

const userChunk = (t: string, messageId?: string) => ({
  sessionUpdate: "user_message_chunk",
  content: { type: "text", text: t },
  ...(messageId === undefined ? {} : { messageId }),
});

describe("applyReplayUpdate", () => {
  it("splits a replayed conversation into user and agent turns", () => {
    const c = ctx();
    let messages = applyReplayUpdate([], userChunk("first"), c);
    messages = applyReplayUpdate(messages, text("one"), c);
    messages = applyReplayUpdate(messages, userChunk("second"), c);
    messages = applyReplayUpdate(messages, text("two"), c);

    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "first"],
      ["agent", "one"],
      ["user", "second"],
      ["agent", "two"],
    ]);
    expect(messages.map((m) => m.isComplete)).toEqual([undefined, true, undefined, undefined]);
  });

  it("joins user chunks that share a messageId", () => {
    const c = ctx();
    const first = applyReplayUpdate([], userChunk("Hello", "m-1"), c);
    const result = applyReplayUpdate(first, userChunk(" world", "m-1"), c);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: "user", content: "Hello world", replayId: "m-1" });
  });

  it("keeps user chunks with different messageIds apart", () => {
    const c = ctx();
    const first = applyReplayUpdate([], userChunk("one", "m-1"), c);
    const result = applyReplayUpdate(first, userChunk("two", "m-2"), c);

    expect(result.map((m) => m.content)).toEqual(["one", "two"]);
    expect(result.map((m) => m.replayId)).toEqual(["m-1", "m-2"]);
  });

  it("changes nothing for an empty user chunk, not even a closing reply", () => {
    const c = ctx();
    const messages = applyAcpUpdate([], text("still going"), c);

    expect(applyReplayUpdate(messages, userChunk(""), c)).toBe(messages);
  });

  it("shows a non-text block as its file's name", () => {
    const result = applyReplayUpdate(
      [],
      { sessionUpdate: "user_message_chunk", content: { type: "resource_link", uri: "file:///repo/docs/design.md" } },
      ctx(),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: "user", content: "design.md" });
  });

  it("hands agent text and tool calls to the normal reducer", () => {
    const base: ChatMessage[] = [{ id: "u-1", role: "user", content: "go", timestamp: 1 }];
    const toolCall = { sessionUpdate: "tool_call", toolCallId: "t-1", title: "Read", status: "in_progress" };
    // The replay's missing time is its only difference: the rest is the normal reducer's work.
    const withoutTime = (messages: ChatMessage[]) =>
      messages.map(({ hasKnownTime: _hasKnownTime, ...message }) => message);

    expect(withoutTime(applyReplayUpdate(base, text("Done"), ctx()))).toEqual(applyAcpUpdate(base, text("Done"), ctx()));
    expect(withoutTime(applyReplayUpdate(base, toolCall, ctx()))).toEqual(applyAcpUpdate(base, toolCall, ctx()));
  });

  it("marks replayed messages as having no known time", () => {
    const c = ctx();
    const user = applyReplayUpdate([], userChunk("first"), c);
    const messages = applyReplayUpdate(user, text("one"), c);

    expect(messages.map((m) => m.hasKnownTime)).toEqual([false, false]);
  });

  it("leaves a live message's time known", () => {
    const message = applyAcpUpdate([], text("live"), ctx())[0];

    expect(message.hasKnownTime).toBeUndefined();
  });
});
