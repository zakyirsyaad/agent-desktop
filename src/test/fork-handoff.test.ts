import { describe, it, expect } from "vitest";
import {
  MAX_HANDOFF_CHARS,
  buildForkHandoff,
  buildForkPrompt,
  buildRewindContext,
  type ForkHandoffMeta,
} from "../lib/fork-handoff";
import type { ChatMessage } from "../types";

const CREATED_AT = Date.UTC(2026, 9, 16, 10, 30, 0);

const meta: ForkHandoffMeta = {
  sourceSessionName: "agent-desktop / feat-real-ui-chat",
  agentName: "Aider",
  cwd: "/Users/test/developer/agent-desktop",
  createdAt: CREATED_AT,
};

const messages: ChatMessage[] = [
  {
    id: "msg-1",
    role: "user",
    content: "Please fix the stream parser",
    timestamp: CREATED_AT - 60_000,
  },
  {
    id: "msg-2",
    role: "agent",
    content: "I edited the parser and the suite is green.",
    timestamp: CREATED_AT - 50_000,
    tools: [
      { id: "t-1", name: "Edit", args: 'file_path: "a.ts"', status: "completed" },
      { id: "t-2", name: "Bash", args: "pnpm test", status: "running" },
    ],
    actionCard: {
      id: "card-1",
      sessionId: "s-1",
      title: "⚠️ Agent Action Approval Required",
      prompt: "Run `pnpm test` in background?",
      commandSnippet: "pnpm test",
      toolName: "Bash",
      status: "pending",
      approvalKey: "y\n",
      rejectKey: "n\n",
      timestamp: CREATED_AT - 40_000,
    },
  },
  {
    id: "msg-3",
    role: "user",
    content: "Now deploy it to production",
    timestamp: CREATED_AT - 30_000,
  },
  {
    id: "msg-4",
    role: "agent",
    content: "Deployed successfully",
    timestamp: CREATED_AT - 20_000,
  },
];

/** Zero-padded marker so `MARKER-001` never matches inside `MARKER-010`. */
function marker(index: number): string {
  return `MARKER-${String(index).padStart(3, "0")}`;
}

/** A message whose content is large enough that a few dozen of them overflow the cap. */
function largeMessage(index: number): ChatMessage {
  return {
    id: `big-${index}`,
    role: index % 2 === 0 ? "user" : "agent",
    content: `${marker(index)}\n${"lorem ipsum dolor sit amet ".repeat(150)}`,
    timestamp: index,
  };
}

describe("MAX_HANDOFF_CHARS", () => {
  it("caps the handoff document at 60000 characters", () => {
    expect(MAX_HANDOFF_CHARS).toBe(60_000);
  });
});

describe("buildForkHandoff header", () => {
  it("starts with the handoff heading and lists every meta field", () => {
    const doc = buildForkHandoff(messages, "msg-2", meta);

    expect(doc.startsWith("# Session handoff")).toBe(true);
    expect(doc).toContain(`- Source session: ${meta.sourceSessionName}`);
    expect(doc).toContain(`- Agent: ${meta.agentName}`);
    expect(doc).toContain(`- Folder: ${meta.cwd}`);
  });

  it("renders Created as an ISO-8601 timestamp", () => {
    const doc = buildForkHandoff(messages, "msg-2", meta);

    expect(doc).toContain(`- Created: ${new Date(CREATED_AT).toISOString()}`);
    expect(doc).toMatch(/- Created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it("warns that files on disk may have changed since this point", () => {
    const doc = buildForkHandoff(messages, "msg-2", meta);

    expect(doc).toContain(
      "> Note: files on disk may have changed since this point in the conversation.",
    );
  });
});

describe("buildForkHandoff sections", () => {
  it("emits a User section before the Agent section in message order", () => {
    const doc = buildForkHandoff(messages, "msg-2", meta);

    const userIdx = doc.indexOf("### User");
    const agentIdx = doc.indexOf("### Agent");

    expect(userIdx).toBeGreaterThan(-1);
    expect(agentIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeLessThan(agentIdx);
    expect(doc.indexOf("# Session handoff")).toBeLessThan(userIdx);
  });

  it("includes the content of both messages up to the fork point", () => {
    const doc = buildForkHandoff(messages, "msg-2", meta);

    expect(doc).toContain("Please fix the stream parser");
    expect(doc).toContain("I edited the parser and the suite is green.");
  });

  it("excludes every message after uptoMessageId", () => {
    const doc = buildForkHandoff(messages, "msg-2", meta);

    expect(doc).not.toContain("Now deploy it to production");
    expect(doc).not.toContain("Deployed successfully");
  });

  it("lists one `- Tool:` line per tool execution, before the message content", () => {
    const doc = buildForkHandoff(messages, "msg-2", meta);

    expect(doc).toContain('- Tool: Edit(file_path: "a.ts")');
    expect(doc).toContain("- Tool: Bash(pnpm test)");

    const toolIdx = doc.indexOf("- Tool: Edit");
    const contentIdx = doc.indexOf("I edited the parser");
    expect(doc.indexOf("### Agent")).toBeLessThan(toolIdx);
    expect(toolIdx).toBeLessThan(contentIdx);
  });

  it("lists the pending approval after the tool lines and before the content", () => {
    const doc = buildForkHandoff(messages, "msg-2", meta);

    expect(doc).toContain("- Approval requested: Run `pnpm test` in background? (pending)");

    const toolIdx = doc.indexOf("- Tool: Edit");
    const approvalIdx = doc.indexOf("- Approval requested:");
    const contentIdx = doc.indexOf("I edited the parser");
    expect(toolIdx).toBeLessThan(approvalIdx);
    expect(approvalIdx).toBeLessThan(contentIdx);
  });

  it("reports a resolved action card with its own status", () => {
    const approved: ChatMessage[] = [
      {
        ...messages[1],
        actionCard: { ...messages[1].actionCard!, status: "approved" },
      },
    ];

    const doc = buildForkHandoff(approved, "msg-2", meta);

    expect(doc).toContain("- Approval requested: Run `pnpm test` in background? (approved)");
  });

  it("omits tool and approval lines for messages that have neither", () => {
    const doc = buildForkHandoff(messages, "msg-1", meta);

    expect(doc).not.toContain("- Tool:");
    expect(doc).not.toContain("- Approval requested:");
    expect(doc).toContain("### User");
    expect(doc).not.toContain("### Agent");
  });

  it("does not mutate the messages it is given", () => {
    const snapshot = structuredClone(messages);

    buildForkHandoff(messages, "msg-2", meta);

    expect(messages).toEqual(snapshot);
  });

  it("lists the paths of the files a message attached, so the new agent can read them again", () => {
    const attached: ChatMessage[] = [
      { ...messages[0], attachments: ["/repo/design.png", "/repo/my notes.md"] },
    ];

    const document = buildForkHandoff(attached, "msg-1", meta);

    expect(document).toContain("- Attached: /repo/design.png");
    expect(document).toContain("- Attached: /repo/my notes.md");
  });
});

describe("buildForkHandoff unknown ids", () => {
  it("throws an error naming the id it could not find", () => {
    expect(() => buildForkHandoff(messages, "msg-99", meta)).toThrow(/msg-99/);
    expect(() => buildForkHandoff(messages, "msg-99", meta)).toThrow(Error);
  });

  it("throws for an empty conversation", () => {
    expect(() => buildForkHandoff([], "msg-1", meta)).toThrow(/msg-1/);
  });
});

describe("buildForkHandoff truncation", () => {
  const bigMessages = Array.from({ length: 40 }, (_, index) => largeMessage(index));
  const uptoId = bigMessages[bigMessages.length - 1].id;
  const doc = buildForkHandoff(bigMessages, uptoId, meta);
  const keptIndexes = bigMessages
    .map((_, index) => index)
    .filter((index) => doc.includes(marker(index)));
  const droppedCount = bigMessages.length - keptIndexes.length;

  it("never exceeds MAX_HANDOFF_CHARS", () => {
    expect(doc.length).toBeGreaterThan(MAX_HANDOFF_CHARS * 0.5);
    expect(doc.length).toBeLessThanOrEqual(MAX_HANDOFF_CHARS);
  });

  it("keeps the newest message, which is the one being forked from", () => {
    expect(doc).toContain(marker(bigMessages.length - 1));
  });

  it("drops the oldest message", () => {
    expect(doc).not.toContain(marker(0));
    expect(droppedCount).toBeGreaterThan(0);
  });

  it("drops from the oldest end only, keeping a contiguous newest tail", () => {
    expect(keptIndexes).toHaveLength(bigMessages.length - droppedCount);
    expect(keptIndexes[0]).toBe(droppedCount);
    expect(keptIndexes[keptIndexes.length - 1]).toBe(bigMessages.length - 1);
  });

  it("records how many earlier messages were omitted", () => {
    expect(doc).toContain(`_${droppedCount} earlier messages omitted._`);
  });

  it("places the omission note after the header warning and before the first section", () => {
    const noteIdx = doc.indexOf("> Note: files on disk may have changed");
    const omittedIdx = doc.indexOf("earlier messages omitted");
    const firstSectionIdx = doc.indexOf("### ");

    expect(omittedIdx).toBeGreaterThan(noteIdx);
    expect(omittedIdx).toBeLessThan(firstSectionIdx);
  });

  it("keeps the header intact after truncation", () => {
    expect(doc.startsWith("# Session handoff")).toBe(true);
    expect(doc).toContain(`- Source session: ${meta.sourceSessionName}`);
  });

  it("omits the note entirely when nothing had to be dropped", () => {
    const shortDoc = buildForkHandoff(messages, "msg-4", meta);

    expect(shortDoc).not.toContain("earlier messages omitted");
    expect(shortDoc).toContain("Deployed successfully");
    expect(shortDoc.length).toBeLessThanOrEqual(MAX_HANDOFF_CHARS);
  });

  it("still respects the cap when a single message is larger than MAX_HANDOFF_CHARS", () => {
    const huge: ChatMessage = {
      id: "huge-1",
      role: "agent",
      content: `HUGE-START\n${"x".repeat(MAX_HANDOFF_CHARS + 5_000)}`,
      timestamp: 1,
    };

    const hugeDoc = buildForkHandoff([huge], "huge-1", meta);

    expect(hugeDoc.length).toBeLessThanOrEqual(MAX_HANDOFF_CHARS);
    expect(hugeDoc.startsWith("# Session handoff")).toBe(true);
    expect(hugeDoc).toContain("HUGE-START");
  });
});

describe("buildForkPrompt", () => {
  it("asks the agent to read the handoff file and confirm readiness", () => {
    const prompt = buildForkPrompt("/data/handoffs/abc-123.md");

    expect(prompt).toBe(
      'Read the file "/data/handoffs/abc-123.md" for the context of a previous session, ' +
        "then continue from where it left off. Reply briefly that you are ready.",
    );
    expect(prompt).toContain("/data/handoffs/abc-123.md");
  });

  it("quotes the path so a space in the app data dir cannot split it", () => {
    const prompt = buildForkPrompt("/Users/me/Library/Application Support/app/handoffs/a.md");

    expect(prompt).toContain('"/Users/me/Library/Application Support/app/handoffs/a.md"');
  });

  it("stays on a single line so it can be written to a PTY as one keystroke batch", () => {
    const prompt = buildForkPrompt("/data/handoffs/abc-123.md");

    expect(prompt).not.toContain("\n");
    expect(prompt).not.toContain("\r");
  });

  it("flattens newlines in the path instead of passing them through", () => {
    const prompt = buildForkPrompt("/data/hand\noffs/ab\r\nc.md");

    expect(prompt).not.toContain("\n");
    expect(prompt).not.toContain("\r");
    expect(prompt.replace(/\s+/g, " ")).toContain("/data/hand offs/ab c.md");
    expect(prompt.startsWith('Read the file "')).toBe(true);
    expect(prompt.endsWith("Reply briefly that you are ready.")).toBe(true);
  });
});

describe("buildRewindContext", () => {
  it("points the fresh agent at the conversation so far, quoted and on one line", () => {
    const context = buildRewindContext("/Users/me/Library/Application Support/app/handoffs/re\nwind.md");

    expect(context).toContain('"/Users/me/Library/Application Support/app/handoffs/re wind.md"');
    expect(context).not.toMatch(/[\r\n]/);
    expect(context).toContain("answer my message below");
  });
});
