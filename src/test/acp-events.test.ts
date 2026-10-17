import { describe, it, expect } from "vitest";
import {
  applyAcpUpdate,
  applyPermissionRequest,
  closeTurn,
  pendingPermissionCards,
  resolvePermissionCard,
  type AcpReducerContext,
} from "../lib/acp-events";
import type { ChatMessage } from "../types";

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

    expect(started[0].tools).toEqual([
      { id: "t-1", name: "Read src/App.tsx", args: "", status: "running", kind: "read" },
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
    expect(pendingPermissionCards(both).map((card) => card.requestId)).toEqual(["perm-1", "perm-2"]);
  });

  it("closing a turn closes every unanswered request, not only the last one", () => {
    const c = ctx();
    const both = applyPermissionRequest(applyPermissionRequest([], request, c), { ...request, requestId: "perm-2" }, c);

    const closed = closeTurn(both);

    expect(closed.map((m) => m.actionCard?.status)).toEqual(["rejected", "rejected"]);
    expect(pendingPermissionCards(closed)).toEqual([]);
  });
});

