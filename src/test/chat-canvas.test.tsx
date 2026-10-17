import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ActionCard } from "../components/ActionCard";
import { ChatCanvas, type ChatMessage } from "../components/ChatCanvas";
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
    title: "⚠️ Agent Action Approval Required",
    prompt: "Agent wants to edit file `src/main.ts`",
    commandSnippet: "npm run build",
    toolName: "Bash",
    status: "pending",
    approvalKey: "y\n",
    rejectKey: "n\n",
    timestamp: Date.now(),
  };

  it("renders card title, prompt description, and command snippet", () => {
    render(
      <ActionCard
        card={mockCard}
        onApprove={() => {}}
        onReject={() => {}}
      />
    );

    expect(screen.getByText("⚠️ Agent Action Approval Required")).toBeDefined();
    expect(screen.getByText(/Agent wants to edit file/i)).toBeDefined();
    expect(screen.getByText("npm run build")).toBeDefined();
    expect(screen.getByText(/Tool: Bash/i)).toBeDefined();
  });

  it("calls onApprove with approvalKey ('y\\n') when Approve button is clicked", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();

    render(
      <ActionCard
        card={mockCard}
        onApprove={onApprove}
        onReject={onReject}
      />
    );

    const approveBtn = screen.getByRole("button", { name: /approve/i });
    expect(approveBtn).toBeDefined();
    fireEvent.click(approveBtn);

    expect(onApprove).toHaveBeenCalledWith("y\n");
    expect(onReject).not.toHaveBeenCalled();
  });

  it("offers no in-place command editing, so approval always targets the agent's original command", () => {
    // Typing an edited command into a y/n prompt can approve the ORIGINAL command
    // (e.g. "yarn clean" starts with "y"), so the card must not offer editing.
    render(
      <ActionCard
        card={mockCard}
        onApprove={() => {}}
        onReject={() => {}}
      />
    );

    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
    expect(screen.queryByLabelText(/edit command/i)).toBeNull();
  });

  it("calls onReject with rejectKey ('n\\n') when Reject button is clicked", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();

    render(
      <ActionCard
        card={mockCard}
        onApprove={onApprove}
        onReject={onReject}
      />
    );

    const rejectBtn = screen.getByRole("button", { name: /reject/i });
    expect(rejectBtn).toBeDefined();
    fireEvent.click(rejectBtn);

    expect(onReject).toHaveBeenCalledWith("n\n");
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("disables buttons when status is approved or rejected or disabled prop is set", () => {
    const approvedCard: ActionCardType = {
      ...mockCard,
      status: "approved",
    };

    const { rerender } = render(
      <ActionCard
        card={approvedCard}
        onApprove={() => {}}
        onReject={() => {}}
      />
    );

    const approveBtn = screen.getByRole("button", { name: /approved/i });
    expect((approveBtn as HTMLButtonElement).disabled).toBe(true);

    // Test with disabled prop
    rerender(
      <ActionCard
        card={mockCard}
        onApprove={() => {}}
        onReject={() => {}}
        disabled={true}
      />
    );

    const pendingApproveBtn = screen.getByRole("button", { name: /approve/i });
    expect((pendingApproveBtn as HTMLButtonElement).disabled).toBe(true);
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
          args: 'file_path: "src/App.tsx"',
          status: "completed",
        },
        {
          id: "t-2",
          name: "Bash",
          args: "pnpm test",
          status: "running",
        },
      ],
      actionCard: {
        id: "card-act-1",
        sessionId: "s-1",
        title: "⚠️ Agent Action Approval Required",
        prompt: "Run command `pnpm test` in background?",
        commandSnippet: "pnpm test",
        toolName: "Bash",
        status: "pending",
        approvalKey: "y\n",
        rejectKey: "n\n",
        timestamp: Date.now() - 30000,
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
        onSendPtyInput={() => {}}
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
        onSendPtyInput={() => {}}
      />
    );

    const copyBtn = screen.getByRole("button", { name: /copy code/i });
    expect(copyBtn).toBeDefined();

    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("pnpm install && pnpm build");
  });

  it("renders tool execution chips with completed and running statuses", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
        onSendPtyInput={() => {}}
      />
    );

    // Tool chip 1: completed
    expect(screen.getByText(/Edit\(file_path:\s*"src\/App\.tsx"\)/i)).toBeDefined();
    expect(screen.getByText(/Completed/i)).toBeDefined();

    // Tool chip 2: running
    expect(screen.getByText(/Bash\(pnpm test\)/i)).toBeDefined();
    expect(screen.getByText(/Running/i)).toBeDefined();
  });

  it("renders ActionCard when message has an approval_request actionCard", () => {
    const onSendPtyInput = vi.fn();

    render(
      <ChatCanvas
        messages={mockMessages}
        onSendPtyInput={onSendPtyInput}
      />
    );

    expect(screen.getByText("⚠️ Agent Action Approval Required")).toBeDefined();
    expect(screen.getByText("Run command `pnpm test` in background?")).toBeDefined();

    const approveBtn = screen.getByRole("button", { name: /approve/i });
    fireEvent.click(approveBtn);

    expect(onSendPtyInput).toHaveBeenCalledWith("y\n");
  });

  it("does not expose an Edit control on action cards, so only approval/rejection keys reach the PTY", () => {
    const onApproveAction = vi.fn();

    render(
      <ChatCanvas
        messages={mockMessages}
        onSendPtyInput={() => {}}
        onApproveAction={onApproveAction}
      />
    );

    expect(screen.queryByRole("button", { name: /^edit$/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(onApproveAction).toHaveBeenCalledWith("y\n", expect.any(String));
  });

  it("renders message action bar (Copy, Fork, Audio, timestamp)", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
        onSendPtyInput={() => {}}
        onForkBranch={() => {}}
      />
    );

    // Message action bar buttons
    expect(screen.getByRole("button", { name: /copy message/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /fork branch/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /read aloud/i })).toBeDefined();
    expect(screen.getByText(/ago/i)).toBeDefined();
  });

  it("labels agent messages with the active agent name instead of a hard-coded product", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
        onSendPtyInput={() => {}}
        agentName="Aider"
      />
    );

    expect(screen.getByText("Aider")).toBeDefined();
    expect(screen.queryByText("Claude Code")).toBeNull();
  });

  it("falls back to a generic Agent label when no agentName is provided", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
        onSendPtyInput={() => {}}
      />
    );

    expect(screen.getByText("Agent")).toBeDefined();
    expect(screen.queryByText("Claude Code")).toBeNull();
  });

  it("hides the Fork button when the host app cannot fork a branch", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
        onSendPtyInput={() => {}}
      />
    );

    expect(screen.queryByRole("button", { name: /fork branch/i })).toBeNull();
  });

  it("calls onForkBranch with the agent message id when Fork is clicked", () => {
    const onForkBranch = vi.fn();

    render(
      <ChatCanvas
        messages={mockMessages}
        onSendPtyInput={() => {}}
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
        onSendPtyInput={() => {}}
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
        onSendPtyInput={() => {}}
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
        onSendPtyInput={() => {}}
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
        onSendPtyInput={() => {}}
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
        onSendPtyInput={() => {}}
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
        onSendPtyInput={() => {}}
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
        onSendPtyInput={() => {}}
      />
    );

    expect(screen.queryByRole("button", { name: /read aloud/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /stop reading/i })).toBeNull();
    expect(screen.getByRole("button", { name: /copy message/i })).toBeDefined();
  });

  it("stops the utterance when the canvas unmounts mid-speech", () => {
    const { unmount } = render(
      <ChatCanvas
        messages={mockMessages}
        onSendPtyInput={() => {}}
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
        onSendPtyInput={() => {}}
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
    approvalKey: "",
    rejectKey: "",
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
        onSendPtyInput={() => {}}
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
        onSendPtyInput={() => {}}
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
        onSendPtyInput={() => {}}
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
            tools: [{ id: "t-1", name: "Read src/App.tsx", args: "", status: "completed", kind: "read" }],
          },
        ]}
        onSendPtyInput={() => {}}
      />
    );

    expect(screen.getByText("Read src/App.tsx")).toBeDefined();
    expect(screen.queryByText(/\(\)/)).toBeNull();
  });
});
