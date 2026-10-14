import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ActionCard } from "../components/ActionCard";
import { ChatCanvas, type ChatMessage } from "../components/ChatCanvas";
import type { ActionCard as ActionCardType } from "../types";

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

  it("calls onEdit callback when Edit button is clicked", () => {
    const onEdit = vi.fn();

    render(
      <ActionCard
        card={mockCard}
        onApprove={() => {}}
        onReject={() => {}}
        onEdit={onEdit}
      />
    );

    const editBtn = screen.getByRole("button", { name: /edit/i });
    expect(editBtn).toBeDefined();
    fireEvent.click(editBtn);

    expect(onEdit).toHaveBeenCalledTimes(1);
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

  beforeEach(() => {
    // Mock navigator.clipboard
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockImplementation(() => Promise.resolve()),
      },
    });
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
    expect(screen.getByText(/Tool:\s*Edit\(file_path:\s*"src\/App\.tsx"\)/i)).toBeDefined();
    expect(screen.getByText(/Completed/i)).toBeDefined();

    // Tool chip 2: running
    expect(screen.getByText(/Tool:\s*Bash\(pnpm test\)/i)).toBeDefined();
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

  it("renders message action bar (Copy, Fork, Audio, timestamp)", () => {
    render(
      <ChatCanvas
        messages={mockMessages}
        onSendPtyInput={() => {}}
      />
    );

    // Message action bar buttons
    expect(screen.getByRole("button", { name: /copy message/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /fork branch/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /read aloud/i })).toBeDefined();
    expect(screen.getByText(/ago/i)).toBeDefined();
  });
});
