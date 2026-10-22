import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ActionCard, NO_OPTIONS_MESSAGE } from "../components/ActionCard";
import { ChatCanvas, type ChatMessage } from "../components/ChatCanvas";
import { HistoryElsewhereNote } from "../components/chat/HistoryElsewhereNote";
import type { ActionCard as ActionCardType } from "../types";
import {
  installSpeechMock,
  uninstallSpeechMock,
  type SpeechMock,
} from "./helpers/speech-mock";

describe("ActionCard Component", () => {
  const mockCard: ActionCardType = {
    id: "card-1",
    sessionId: "session-1",
    title: "Permission requested",
    prompt: "Agent wants to edit file `src/main.ts`",
    commandSnippet: "npm run build",
    toolName: "Bash",
    status: "pending",
    timestamp: Date.now(),
    requestId: "perm-1",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  };

  it("renders card title, prompt description, and command snippet", () => {
    render(<ActionCard card={mockCard} />);

    expect(screen.getByText("Permission requested")).toBeDefined();
    expect(screen.getByText(/Agent wants to edit file/i)).toBeDefined();
    expect(screen.getByText("npm run build")).toBeDefined();
    expect(screen.getByText(/Tool: Bash/i)).toBeDefined();
  });

  it("calls onChoose with the option the user picked", () => {
    const onChoose = vi.fn();
    render(<ActionCard card={mockCard} onChoose={onChoose} />);

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(onChoose).toHaveBeenCalledWith("reject");
  });

  it("disables the choices when the disabled prop is set, and shows the pick once answered", () => {
    const { rerender } = render(<ActionCard card={mockCard} onChoose={() => {}} disabled />);

    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<ActionCard card={{ ...mockCard, status: "approved", chosenOptionId: "allow" }} onChoose={() => {}} />);

    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.getByText("You chose: Allow")).toBeDefined();
  });

  it("says how to continue when a pending request has no options to pick", () => {
    render(<ActionCard card={{ ...mockCard, options: [] }} onChoose={() => {}} />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(NO_OPTIONS_MESSAGE)).toBeDefined();
  });

  it("says a request was not answered when it ended without a pick", () => {
    render(<ActionCard card={{ ...mockCard, status: "rejected" }} />);

    expect(screen.getByText("This request was not answered.")).toBeDefined();
  });
});

describe("ChatCanvas Component", () => {
  const mockMessages: ChatMessage[] = [
    {
      id: "msg-1",
      role: "user",
      content: "Can you list the project structure and build commands?",
      timestamp: Date.now() - 120000,
    },
    {
      id: "msg-2",
      role: "agent",
      content: `# Project Structure Overview

Here is the plan for building the application:

1. Install dependencies with package manager
2. Compile typescript with strict check
3. Run the unit test suite

Check out the \`package.json\` script:

\`\`\`bash
pnpm install && pnpm build
\`\`\`

All systems ready for compilation.`,
      timestamp: Date.now() - 60000,
      tools: [
        {
          id: "t-1",
          name: "Edit",
          status: "completed",
        },
        {
          id: "t-2",
          name: "Bash",
          status: "running",
        },
      ],
      actionCard: {
        id: "card-act-1",
        sessionId: "s-1",
        title: "Permission requested",
        prompt: "Run command `pnpm test` in background?",
        commandSnippet: "pnpm test",
        toolName: "Bash",
        status: "approved",
        chosenOptionId: "allow",
        timestamp: Date.now() - 30000,
        requestId: "perm-1",
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    },
  ];

  /** Two agent messages so read-aloud ownership can be tested. */
  const twoAgentMessages: ChatMessage[] = [
    ...mockMessages,
    {
      id: "msg-3",
      role: "agent",
      content: "Second reply with **bold** text.",
      timestamp: Date.now() - 30000,
    },
  ];

  let speech: SpeechMock;

  beforeEach(() => {
    // Mock navigator.clipboard
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockImplementation(() => Promise.resolve()),
      },
    });
    speech = installSpeechMock();
  });

  afterEach(() => {
    uninstallSpeechMock();
  });

  it("renders user and agent messages with clean markdown formatting", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
      />
    );

    // User message
    expect(screen.getByText("Can you list the project structure and build commands?")).toBeDefined();

    // Markdown elements: heading
    expect(screen.getByText("Project Structure Overview")).toBeDefined();

    // Ordered list items
    expect(screen.getByText("Install dependencies with package manager")).toBeDefined();
    expect(screen.getByText("Compile typescript with strict check")).toBeDefined();
    expect(screen.getByText("Run the unit test suite")).toBeDefined();

    // Inline code badge
    expect(screen.getByText("package.json")).toBeDefined();

    // Code block
    expect(screen.getByText("pnpm install && pnpm build")).toBeDefined();
  });

  it("copies code block snippet when Copy code button is clicked", async () => {
    render(
      <ChatCanvas
        messages={mockMessages}
      />
    );

    const copyBtn = screen.getByRole("button", { name: /copy code/i });
    expect(copyBtn).toBeDefined();

    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("pnpm install && pnpm build");
  });

  it("shows a running tool on the collapsed summary row and reveals the rest on click", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
      />
    );

    const summary = screen.getByRole("button", { name: /Bash/ });
    expect(summary.textContent).toContain("Running");
    expect(screen.queryByText("Edit")).toBeNull();

    fireEvent.click(summary);

    expect(screen.getByText("Edit")).toBeDefined();
    expect(screen.getByText(/Completed/i)).toBeDefined();
  });

  it("renders the ActionCard of a message with a permission request and reports the pick with its card", () => {
    const onChooseOption = vi.fn();
    const waiting = mockMessages.map((message) =>
      message.actionCard
        ? { ...message, actionCard: { ...message.actionCard, status: "pending" as const, chosenOptionId: undefined } }
        : message,
    );

    render(<ChatCanvas messages={waiting} onChooseOption={onChooseOption} />);

    expect(screen.getByText("Permission requested")).toBeDefined();
    expect(screen.getByText("Run command `pnpm test` in background?")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    expect(onChooseOption).toHaveBeenCalledWith("card-act-1", "allow");
  });

  it("renders message action bar (Copy, Fork, Audio, timestamp)", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
        onForkBranch={() => {}}
      />
    );

    // Message action bar buttons (your messages have a Copy of their own)
    expect(screen.getAllByRole("button", { name: /copy message/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /fork branch/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /read aloud/i })).toBeDefined();
    expect(screen.getAllByText(/ago/i).length).toBeGreaterThan(0);
  });

  it("labels agent messages with the active agent name instead of a hard-coded product", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
        agentName="Codex"
      />
    );

    expect(screen.getByText("Codex")).toBeDefined();
    expect(screen.queryByText("Claude Code")).toBeNull();
  });

  it("falls back to a generic Agent label when no agentName is provided", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
      />
    );

    expect(screen.getByText("Agent")).toBeDefined();
    expect(screen.queryByText("Claude Code")).toBeNull();
  });

  it("hides the Fork button when the host app cannot fork a branch", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
      />
    );

    expect(screen.queryByRole("button", { name: /fork branch/i })).toBeNull();
  });

  it("calls onForkBranch with the agent message id when Fork is clicked", () => {
    const onForkBranch = vi.fn();

    render(
      <ChatCanvas
        messages={mockMessages}
        onForkBranch={onForkBranch}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /fork branch/i }));

    expect(onForkBranch).toHaveBeenCalledTimes(1);
    expect(onForkBranch).toHaveBeenCalledWith("msg-2");
  });

  it("speaks a markdown-free version of the message and offers to stop", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /read aloud/i }));

    expect(speech.speak).toHaveBeenCalledTimes(1);
    const spoken = speech.utterances[0];
    expect(spoken.text).not.toContain("```");
    expect(spoken.text).toContain("code block omitted");
    expect(spoken.text).toContain("Project Structure Overview");

    expect(screen.getByRole("button", { name: /stop reading/i })).toBeDefined();
  });

  it("stops speaking and restores the Read aloud label when Stop reading is clicked", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /read aloud/i }));
    speech.cancel.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /stop reading/i }));

    expect(speech.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /read aloud/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /stop reading/i })).toBeNull();
  });

  it("resets to Read aloud when the current utterance ends on its own", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /read aloud/i }));
    const utterance = speech.utterances[0];

    act(() => {
      utterance.onend?.();
    });

    expect(screen.getByRole("button", { name: /read aloud/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /stop reading/i })).toBeNull();
  });

  it("keeps a single speaker when Read aloud is clicked on a second message", () => {
    render(
      <ChatCanvas
        messages={twoAgentMessages}
      />
    );

    const second = screen.getByTestId("chat-message-msg-2");
    const third = screen.getByTestId("chat-message-msg-3");

    fireEvent.click(within(second).getByRole("button", { name: /read aloud/i }));
    fireEvent.click(within(third).getByRole("button", { name: /read aloud/i }));

    expect(screen.getAllByRole("button", { name: /stop reading/i })).toHaveLength(1);
    expect(within(third).getByRole("button", { name: /stop reading/i })).toBeDefined();
    expect(within(second).getByRole("button", { name: /read aloud/i })).toBeDefined();
  });

  it("ignores the end event of a superseded utterance so the new speaker keeps reading", () => {
    render(
      <ChatCanvas
        messages={twoAgentMessages}
      />
    );

    const second = screen.getByTestId("chat-message-msg-2");
    const third = screen.getByTestId("chat-message-msg-3");

    fireEvent.click(within(second).getByRole("button", { name: /read aloud/i }));
    fireEvent.click(within(third).getByRole("button", { name: /read aloud/i }));

    const superseded = speech.utterances[0];
    act(() => {
      superseded.onend?.();
    });

    expect(within(third).getByRole("button", { name: /stop reading/i })).toBeDefined();
    expect(screen.getAllByRole("button", { name: /stop reading/i })).toHaveLength(1);
  });

  it("ignores a stale end event after the same message is stopped and restarted", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /read aloud/i }));
    fireEvent.click(screen.getByRole("button", { name: /stop reading/i }));
    fireEvent.click(screen.getByRole("button", { name: /read aloud/i }));

    act(() => {
      speech.utterances[0].onerror?.({ error: "canceled" });
    });

    expect(screen.getByRole("button", { name: /stop reading/i })).toBeDefined();
  });

  it("hides Read aloud entirely when the platform has no speech engine", () => {
    uninstallSpeechMock();

    render(
      <ChatCanvas
        messages={mockMessages}
      />
    );

    expect(screen.queryByRole("button", { name: /read aloud/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /stop reading/i })).toBeNull();
    expect(screen.getAllByRole("button", { name: /copy message/i }).length).toBeGreaterThan(0);
  });

  it("stops the utterance when the canvas unmounts mid-speech", () => {
    const { unmount } = render(
      <ChatCanvas
        messages={mockMessages}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /read aloud/i }));
    speech.cancel.mockClear();

    unmount();

    expect(speech.cancel).toHaveBeenCalledTimes(1);
  });

  it("does not cancel on unmount when nothing was being read", () => {
    const { unmount } = render(
      <ChatCanvas
        messages={mockMessages}
      />
    );

    speech.cancel.mockClear();
    unmount();

    expect(speech.cancel).not.toHaveBeenCalled();
  });
});

describe("ACP chat content", () => {
  const permissionCard: ActionCardType = {
    id: "act-acp",
    sessionId: "s-1",
    title: "Permission requested",
    prompt: "Run rm -rf build",
    toolName: "execute",
    status: "pending",
    timestamp: 1,
    requestId: "perm-1",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  };

  it("offers the agent's own permission choices and reports the pick", () => {
    const onChooseOption = vi.fn();
    render(
      <ChatCanvas
        messages={[{ id: "m-1", role: "agent", content: "", timestamp: 1, actionCard: permissionCard }]}
        onChooseOption={onChooseOption}
      />
    );

    expect(screen.getByRole("button", { name: "Always allow" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(onChooseOption).toHaveBeenCalledWith("act-acp", "reject");
  });

  it("shows which choice was made once a permission card is answered", () => {
    render(
      <ChatCanvas
        messages={[
          {
            id: "m-1",
            role: "agent",
            content: "",
            timestamp: 1,
            actionCard: { ...permissionCard, status: "approved", chosenOptionId: "always" },
          },
        ]}
        onChooseOption={() => {}}
      />
    );

    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.getByText(/Always allow/)).toBeDefined();
  });

  it("renders the agent's thinking collapsed and its plan with statuses", () => {
    render(
      <ChatCanvas
        messages={[
          {
            id: "m-1",
            role: "agent",
            content: "Working on it",
            timestamp: 1,
            thinking: "First I will read the parser",
            plan: [
              { content: "Read the parser", status: "completed" },
              { content: "Split it in two", status: "in_progress" },
            ],
          },
        ]}
      />
    );

    expect(screen.getByText("Thinking")).toBeDefined();
    expect(screen.getByText("First I will read the parser")).toBeDefined();
    const plan = screen.getByRole("list", { name: "Plan" });
    expect(within(plan).getAllByRole("listitem")).toHaveLength(2);
    expect(within(plan).getByText("Split it in two")).toBeDefined();
  });

  it("shows an ACP tool call by its title, without empty parentheses", () => {
    render(
      <ChatCanvas
        messages={[
          {
            id: "m-1",
            role: "agent",
            content: "",
            timestamp: 1,
            tools: [{ id: "t-1", name: "Read src/App.tsx", status: "completed", kind: "read" }],
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Read a file" }));

    expect(screen.getByText("Read src/App.tsx")).toBeDefined();
    expect(screen.queryByText(/\(\)/)).toBeNull();
  });

  it("renders a reply's text and tools in the order they happened", () => {
    render(
      <ChatCanvas
        messages={[
          {
            id: "m-1",
            role: "agent",
            content: "Before\n\nAfter",
            timestamp: 1,
            tools: [
              { id: "t-1", name: "pnpm test", status: "completed", kind: "execute" },
              { id: "t-2", name: "Read src/App.tsx", status: "completed", kind: "read" },
            ],
            parts: [
              { kind: "text", text: "Before" },
              { kind: "tools", toolIds: ["t-1", "t-2"] },
              { kind: "text", text: "After" },
            ],
          },
        ]}
      />
    );

    const row = screen.getByTestId("chat-message-m-1");
    const text = row.textContent ?? "";
    expect(text.indexOf("Before")).toBeLessThan(text.indexOf("Ran a command"));
    expect(text.indexOf("Ran a command")).toBeLessThan(text.indexOf("After"));
  });

  it("shows a tools part as one summary row, collapsed", () => {
    render(
      <ChatCanvas
        messages={[
          {
            id: "m-1",
            role: "agent",
            content: "",
            timestamp: 1,
            tools: [
              { id: "t-1", name: "pnpm test", status: "completed", kind: "execute" },
              { id: "t-2", name: "Read src/App.tsx", status: "completed", kind: "read" },
            ],
            parts: [{ kind: "tools", toolIds: ["t-1", "t-2"] }],
          },
        ]}
      />
    );

    const summary = screen.getByRole("button", { name: "Ran a command, read a file" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("pnpm test")).toBeNull();
  });

  it("shows the tools when a summary row is expanded", () => {
    render(
      <ChatCanvas
        messages={[
          {
            id: "m-1",
            role: "agent",
            content: "",
            timestamp: 1,
            tools: [
              { id: "t-1", name: "pnpm test", status: "completed", kind: "execute" },
              { id: "t-2", name: "Read src/App.tsx", status: "completed", kind: "read" },
            ],
            parts: [{ kind: "tools", toolIds: ["t-1", "t-2"] }],
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Ran a command, read a file" }));

    expect(screen.getByRole("button", { name: "Ran a command, read a file" }).getAttribute("aria-expanded")).toBe(
      "true"
    );
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByText("Read src/App.tsx")).toBeTruthy();
  });

  it("opens a tools part with a diff without a click", () => {
    render(
      <ChatCanvas
        messages={[
          {
            id: "m-1",
            role: "agent",
            content: "",
            timestamp: 1,
            tools: [
              {
                id: "t-1",
                name: "Edit src/app.ts",
                status: "completed",
                kind: "edit",
                details: [{ kind: "diff", path: "src/app.ts", oldText: "a", newText: "b" }],
              },
            ],
            parts: [{ kind: "tools", toolIds: ["t-1"] }],
          },
        ]}
      />
    );

    expect(screen.getByRole("button", { name: "Edited a file" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("src/app.ts")).toBeTruthy();
  });

  it("shows a running tool's title and state on its summary row", () => {
    render(
      <ChatCanvas
        messages={[
          {
            id: "m-1",
            role: "agent",
            content: "",
            timestamp: 1,
            tools: [{ id: "t-1", name: "pnpm test", status: "running", kind: "execute" }],
            parts: [{ kind: "tools", toolIds: ["t-1"] }],
          },
        ]}
      />
    );

    const summary = screen.getByRole("button", { name: /pnpm test/ });
    expect(summary.textContent).toContain("Running");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
  });

  it("gives a message saved without parts the same compact tool rows", () => {
    render(
      <ChatCanvas
        messages={[
          {
            id: "m-1",
            role: "agent",
            content: "The answer.",
            timestamp: 1,
            tools: [{ id: "t-1", name: "Read src/App.tsx", status: "completed", kind: "read" }],
          },
        ]}
      />
    );

    const message = screen.getByTestId("chat-message-m-1");
    const row = within(message);
    expect(row.getByRole("button", { name: "Read a file" })).toBeDefined();
    expect(row.getByText("The answer.")).toBeDefined();
    expect(row.queryByText("Read src/App.tsx")).toBeNull();

    const text = message.textContent ?? "";
    expect(text.indexOf("Read a file")).toBeLessThan(text.indexOf("The answer."));

    fireEvent.click(row.getByRole("button", { name: "Read a file" }));

    expect(row.getByText("Read src/App.tsx")).toBeDefined();
  });

  it("does not show an agent reply that has nothing in it", () => {
    render(
      <ChatCanvas
        messages={[
          { id: "u-1", role: "user", content: "say ok", timestamp: 1 },
          { id: "a-1", role: "agent", content: "ok", timestamp: 2 },
          { id: "a-2", role: "agent", content: "", timestamp: 3 },
        ]}
      />
    );

    expect(screen.getByTestId("chat-message-a-1")).toBeDefined();
    expect(screen.queryByTestId("chat-message-a-2")).toBeNull();
  });

  it("shows the reasoning as a collapsed 'Thinking' row while the reply streams, and 'Thought' once done", () => {
    const reply = { id: "a-1", role: "agent" as const, content: "ok", timestamp: 1, thinking: "Let me check" };
    const { rerender } = render(<ChatCanvas messages={[reply]} />);

    const summary = screen.getByText("Thinking");
    expect(summary.closest("details")?.open).toBe(false);

    rerender(<ChatCanvas messages={[{ ...reply, isComplete: true }]} />);
    expect(screen.getByText("Thought")).toBeDefined();
  });

  it("shows the agent working at the end of the conversation", () => {
    const messages = [{ id: "u-1", role: "user" as const, content: "go", timestamp: 1 }];
    const { rerender } = render(<ChatCanvas messages={messages} isWorking />);

    expect(screen.getByTestId("agent-working").textContent).toMatch(/working/i);

    rerender(<ChatCanvas messages={messages} />);
    expect(screen.queryByTestId("agent-working")).toBeNull();
  });

  it("keeps the reply actions off the turn that is still running", () => {
    const messages: ChatMessage[] = [
      { id: "u-1", role: "user", content: "first", timestamp: 1 },
      { id: "a-1", role: "agent", content: "finished reply", timestamp: 2, isComplete: true },
      { id: "u-2", role: "user", content: "follow-up", timestamp: 3 },
      { id: "a-2", role: "agent", content: "still working", timestamp: 4 },
    ];
    const { rerender } = render(<ChatCanvas messages={messages} isWorking onForkBranch={() => {}} />);

    const finished = within(screen.getByTestId("chat-message-a-1"));
    expect(finished.getByRole("button", { name: "Copy message" })).toBeDefined();
    expect(finished.getByRole("button", { name: "Fork branch" })).toBeDefined();

    const running = within(screen.getByTestId("chat-message-a-2"));
    expect(running.queryByRole("button", { name: "Copy message" })).toBeNull();
    expect(running.queryByRole("button", { name: "Fork branch" })).toBeNull();
    expect(running.queryByRole("button", { name: "Read aloud" })).toBeNull();
    expect(running.queryByText(/ago/i)).toBeNull();

    rerender(<ChatCanvas messages={messages} isWorking={false} onForkBranch={() => {}} />);

    const ended = within(screen.getByTestId("chat-message-a-2"));
    expect(ended.getByRole("button", { name: "Copy message" })).toBeDefined();
    expect(ended.getByRole("button", { name: "Fork branch" })).toBeDefined();
  });

  it("keeps reply actions off a turn that waits for a permission answer", () => {
    const messages: ChatMessage[] = [
      { id: "u-1", role: "user", content: "first", timestamp: 1 },
      { id: "a-1", role: "agent", content: "finished reply", timestamp: 2, isComplete: true },
      { id: "u-2", role: "user", content: "run it", timestamp: 3 },
      { id: "a-2", role: "agent", content: "half an answer", timestamp: 4 },
      { id: "a-3", role: "agent", content: "", timestamp: 5, actionCard: permissionCard },
    ];
    render(<ChatCanvas messages={messages} isWorking={false} onForkBranch={() => {}} />);

    expect(within(screen.getByTestId("chat-message-a-1")).getByRole("button", { name: "Copy message" })).toBeDefined();
    expect(within(screen.getByTestId("chat-message-a-2")).queryByRole("button", { name: "Copy message" })).toBeNull();
    expect(within(screen.getByTestId("chat-message-a-3")).queryByRole("button", { name: "Copy message" })).toBeNull();
  });

  it("marks reasoning done once a later message follows, even without isComplete", () => {
    render(
      <ChatCanvas
        messages={[
          { id: "a-1", role: "agent", content: "first part", timestamp: 1, thinking: "plan" },
          { id: "a-2", role: "agent", content: "second part", timestamp: 2, thinking: "more" },
        ]}
      />
    );

    expect(screen.getByText("Thought")).toBeDefined();
    expect(screen.getByText("Thinking")).toBeDefined();
  });

  it("follows new output to the bottom, unless the user scrolled up to read", () => {
    const first = [{ id: "u-1", role: "user" as const, content: "go", timestamp: 1 }];
    const { rerender } = render(<ChatCanvas messages={first} />);
    const container = screen.getByTestId("chat-canvas-container");
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });

    rerender(<ChatCanvas messages={first} isWorking />);
    expect(container.scrollTop).toBe(1000);

    container.scrollTop = 100;
    fireEvent.scroll(container);
    rerender(<ChatCanvas messages={[...first, { id: "a-1", role: "agent", content: "hi", timestamp: 2 }]} isWorking />);
    expect(container.scrollTop).toBe(100);
  });

  it("jumps to the bottom when the user sends, even if they had scrolled up", () => {
    const first = [{ id: "a-0", role: "agent" as const, content: "earlier answer", timestamp: 1 }];
    const { rerender } = render(<ChatCanvas messages={first} />);
    const container = screen.getByTestId("chat-canvas-container");
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    container.scrollTop = 100;
    fireEvent.scroll(container);

    rerender(
      <ChatCanvas messages={[...first, { id: "u-1", role: "user", content: "follow-up", timestamp: 2 }]} />
    );

    expect(container.scrollTop).toBe(2000);
  });

  it("stops following on a small upward wheel, even while still near the bottom", () => {
    const first = [{ id: "u-1", role: "user" as const, content: "go", timestamp: 1 }];
    const { rerender } = render(<ChatCanvas messages={first} />);
    const container = screen.getByTestId("chat-canvas-container");
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    rerender(<ChatCanvas messages={first} isWorking />);
    expect(container.scrollTop).toBe(1000);

    fireEvent.wheel(container, { deltaY: -8 });
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1200 });
    rerender(
      <ChatCanvas messages={[...first, { id: "a-1", role: "agent", content: "a longer reply", timestamp: 2 }]} isWorking />
    );

    expect(container.scrollTop).toBe(1000);
  });

  it("keeps following when an upward wheel cannot move the view", () => {
    const first = [{ id: "u-1", role: "user" as const, content: "go", timestamp: 1 }];
    const { rerender } = render(<ChatCanvas messages={first} />);
    const container = screen.getByTestId("chat-canvas-container");
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    rerender(<ChatCanvas messages={first} isWorking />);

    // A real browser clamps the earlier scroll to 0 while the list is still
    // short; the wheel then has nowhere to go.
    container.scrollTop = 0;
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 400 });
    fireEvent.wheel(container, { deltaY: -8 });

    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 800 });
    rerender(
      <ChatCanvas messages={[...first, { id: "a-1", role: "agent", content: "a longer reply", timestamp: 2 }]} isWorking />
    );

    expect(container.scrollTop).toBe(800);
  });

  it("keeps following when keys move up while the view cannot", () => {
    const first = [{ id: "u-1", role: "user" as const, content: "go", timestamp: 1 }];
    const { rerender } = render(<ChatCanvas messages={first} />);
    const container = screen.getByTestId("chat-canvas-container");
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    rerender(<ChatCanvas messages={first} isWorking />);

    container.scrollTop = 0;
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 400 });
    fireEvent.keyDown(container, { key: "PageUp" });

    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 800 });
    rerender(
      <ChatCanvas messages={[...first, { id: "a-1", role: "agent", content: "a longer reply", timestamp: 2 }]} isWorking />
    );

    expect(container.scrollTop).toBe(800);
  });

  it("stops following when keys move the view up", () => {
    const first = [{ id: "u-1", role: "user" as const, content: "go", timestamp: 1 }];
    const { rerender } = render(<ChatCanvas messages={first} />);
    const container = screen.getByTestId("chat-canvas-container");
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    rerender(<ChatCanvas messages={first} isWorking />);

    fireEvent.keyDown(container, { key: "PageUp" });
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1200 });
    rerender(
      <ChatCanvas messages={[...first, { id: "a-1", role: "agent", content: "a longer reply", timestamp: 2 }]} isWorking />
    );

    expect(container.scrollTop).toBe(1000);
  });

  it("stops following when a touch drag moves the view up", () => {
    const first = [{ id: "u-1", role: "user" as const, content: "go", timestamp: 1 }];
    const { rerender } = render(<ChatCanvas messages={first} />);
    const container = screen.getByTestId("chat-canvas-container");
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    rerender(<ChatCanvas messages={first} isWorking />);

    fireEvent.touchStart(container, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(container, { touches: [{ clientY: 140 }] });
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1200 });
    rerender(
      <ChatCanvas messages={[...first, { id: "a-1", role: "agent", content: "a longer reply", timestamp: 2 }]} isWorking />
    );

    expect(container.scrollTop).toBe(1000);
  });

  it("follows again once the user scrolls back to the bottom", () => {
    const first = [{ id: "u-1", role: "user" as const, content: "go", timestamp: 1 }];
    const { rerender } = render(<ChatCanvas messages={first} />);
    const container = screen.getByTestId("chat-canvas-container");
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    rerender(<ChatCanvas messages={first} isWorking />);

    fireEvent.wheel(container, { deltaY: -8 });
    container.scrollTop = 1200;
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1200 });
    fireEvent.scroll(container);
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1400 });
    rerender(
      <ChatCanvas messages={[...first, { id: "a-1", role: "agent", content: "a longer reply", timestamp: 2 }]} isWorking />
    );

    expect(container.scrollTop).toBe(1400);
  });

  it("keeps following when its own scroll reports after the content grew", () => {
    const first = [{ id: "u-1", role: "user" as const, content: "go", timestamp: 1 }];
    const { rerender } = render(<ChatCanvas messages={first} />);
    const container = screen.getByTestId("chat-canvas-container");
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    rerender(<ChatCanvas messages={first} isWorking />);

    // The streamed chunk grows the list before the scroll event for our own
    // assignment arrives; that event must not count as the user leaving.
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1600 });
    fireEvent.scroll(container);
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1800 });
    rerender(
      <ChatCanvas messages={[...first, { id: "a-1", role: "agent", content: "a longer reply", timestamp: 2 }]} isWorking />
    );

    expect(container.scrollTop).toBe(1800);
  });
});


describe("ChatCanvas: your messages and the session's header", () => {
  const messages: ChatMessage[] = [
    { id: "u-1", role: "user", content: "fix the parser", timestamp: Date.now() - 120_000 },
    { id: "a-1", role: "agent", content: "Done.", timestamp: Date.now() - 60_000, isComplete: true },
  ];

  it("puts the time, Copy and Rewind under your message, and Rewind names the message", () => {
    const onRewind = vi.fn();
    render(<ChatCanvas messages={messages} onRewind={onRewind} />);
    const yours = within(screen.getByTestId("chat-message-u-1"));

    expect(yours.getByText("2 minutes ago")).toBeDefined();
    expect(yours.getByRole("button", { name: "Copy message" })).toBeDefined();
    fireEvent.click(yours.getByRole("button", { name: "Rewind to here" }));
    // It drops the messages after it, so it takes a confirming second click.
    expect(onRewind).not.toHaveBeenCalled();
    fireEvent.click(yours.getByRole("button", { name: "Confirm rewind" }));

    expect(onRewind).toHaveBeenCalledWith("u-1");
  });

  it("shows no time under a message replayed without one", () => {
    const replayed: ChatMessage[] = [
      { id: "u-2", role: "user", content: "earlier", timestamp: Date.now(), hasKnownTime: false },
      {
        id: "a-2",
        role: "agent",
        content: "reply",
        timestamp: Date.now(),
        isComplete: true,
        hasKnownTime: false,
      },
    ];

    render(<ChatCanvas messages={replayed} />);

    const yours = within(screen.getByTestId("chat-message-u-2"));
    expect(yours.queryByText("Just now")).toBeNull();
    expect(yours.getByRole("button", { name: "Copy message" })).toBeDefined();
    const reply = within(screen.getByTestId("chat-message-a-2"));
    expect(reply.queryByText("Just now")).toBeNull();
    expect(reply.getByRole("button", { name: "Copy message" })).toBeDefined();
  });

  it("turns a Rewind left unconfirmed back by itself", () => {
    vi.useFakeTimers();
    try {
      render(<ChatCanvas messages={messages} onRewind={() => {}} />);
      const yours = within(screen.getByTestId("chat-message-u-1"));
      fireEvent.click(yours.getByRole("button", { name: "Rewind to here" }));

      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(yours.queryByRole("button", { name: "Confirm rewind" })).toBeNull();
      expect(yours.getByRole("button", { name: "Rewind to here" })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers no Rewind when the host cannot rewind, and shows the header above the conversation", () => {
    render(
      <ChatCanvas messages={messages} header={<p>zorvo · ~/developer</p>} />
    );

    expect(screen.queryByRole("button", { name: "Rewind to here" })).toBeNull();
    const container = screen.getByTestId("chat-canvas-container");
    expect(container.firstElementChild?.textContent).toContain("zorvo · ~/developer");
  });

  it("shows a note naming the agent when the header carries one", () => {
    render(
      <ChatCanvas messages={messages} header={<HistoryElsewhereNote agentName="Claude Code" />} />
    );

    const note = screen.getByRole("note");
    expect(note.textContent).toBe("Earlier messages stay in Claude Code. They are not shown here.");
    expect(note.className).toContain("text-fg-muted");
  });

  it("shows no note when there is no history to explain", () => {
    render(<ChatCanvas messages={messages} header={<p>zorvo · ~/developer</p>} />);

    expect(screen.queryByRole("note")).toBeNull();
  });
});
