import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ComposerDock } from "../components/ComposerDock";
import type { AgentProfile } from "../types";

describe("ComposerDock Component", () => {
  const mockAgent: AgentProfile = {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    detected: true,
    models: ["Sonnet 5.5", "Opus 5.5", "Haiku 4.5"],
    effort_levels: ["Low", "Medium", "High"],
  };

  it("renders no usage banner, Upgrade or voice controls (no data source exists for them)", () => {
    render(
      <ComposerDock
        activeAgent={mockAgent}
        selectedModel="Sonnet 5.5"
        selectedEffort="High"
        permissionMode="ask"
        isThinking={false}
        onSendMessage={() => {}}
      />
    );

    expect(screen.queryByText(/usage limit/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /voice dictation/i })).toBeNull();
  });

  it("defaults the permission mode to asking every time", () => {
    render(<ComposerDock activeAgent={mockAgent} onSendMessage={() => {}} />);

    expect(screen.getByText("Ask every time")).toBeDefined();
  });

  it("submits message on Enter without Shift and clears input", () => {
    const onSendMessage = vi.fn();

    render(
      <ComposerDock
        activeAgent={mockAgent}
        selectedModel="Sonnet 5.5"
        selectedEffort="High"
        permissionMode="bypass"
        isThinking={false}
        onSendMessage={onSendMessage}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onPermissionModeChange={() => {}}
      />
    );

    const textarea = screen.getByPlaceholderText(/Type \/ for commands/i) as HTMLTextAreaElement;
    expect(textarea).toBeDefined();

    fireEvent.change(textarea, { target: { value: "Hello Claude agent" } });
    expect(textarea.value).toBe("Hello Claude agent");

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(onSendMessage).toHaveBeenCalledWith("Hello Claude agent");
    expect(textarea.value).toBe("");
  });

  it("allows multiline input on Shift+Enter without sending", () => {
    const onSendMessage = vi.fn();

    render(
      <ComposerDock
        activeAgent={mockAgent}
        selectedModel="Sonnet 5.5"
        selectedEffort="High"
        permissionMode="bypass"
        isThinking={false}
        onSendMessage={onSendMessage}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onPermissionModeChange={() => {}}
      />
    );

    const textarea = screen.getByPlaceholderText(/Type \/ for commands/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Line 1" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(onSendMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Line 1");
  });

  it("submits message when clicking Send button", () => {
    const onSendMessage = vi.fn();

    render(
      <ComposerDock
        activeAgent={mockAgent}
        selectedModel="Sonnet 5.5"
        selectedEffort="High"
        permissionMode="bypass"
        isThinking={false}
        onSendMessage={onSendMessage}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onPermissionModeChange={() => {}}
      />
    );

    const textarea = screen.getByPlaceholderText(/Type \/ for commands/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Send button test" } });

    const sendBtn = screen.getByRole("button", { name: /send message/i });
    expect(sendBtn).toBeDefined();
    fireEvent.click(sendBtn);

    expect(onSendMessage).toHaveBeenCalledWith("Send button test");
    expect(textarea.value).toBe("");
  });

  it("does not send empty or whitespace-only messages", () => {
    const onSendMessage = vi.fn();

    render(
      <ComposerDock
        activeAgent={mockAgent}
        selectedModel="Sonnet 5.5"
        selectedEffort="High"
        permissionMode="bypass"
        isThinking={false}
        onSendMessage={onSendMessage}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onPermissionModeChange={() => {}}
      />
    );

    const textarea = screen.getByPlaceholderText(/Type \/ for commands/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(onSendMessage).not.toHaveBeenCalled();

    const sendBtn = screen.getByRole("button", { name: /send message/i });
    fireEvent.click(sendBtn);
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("renders and updates Permission Mode dropdown ('Bypass permissions' vs 'Ask every time')", () => {
    const onPermissionModeChange = vi.fn();

    render(
      <ComposerDock
        activeAgent={mockAgent}
        selectedModel="Sonnet 5.5"
        selectedEffort="High"
        permissionMode="bypass"
        isThinking={false}
        onSendMessage={() => {}}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onPermissionModeChange={onPermissionModeChange}
      />
    );

    // Initial button displays Bypass permissions
    const permBtn = screen.getByRole("button", { name: /permission mode/i });
    expect(permBtn).toBeDefined();
    expect(screen.getByText("Bypass permissions")).toBeDefined();

    // Click to open dropdown
    fireEvent.click(permBtn);

    const askOption = screen.getByRole("button", { name: /select ask every time/i });
    expect(askOption).toBeDefined();
    fireEvent.click(askOption);

    expect(onPermissionModeChange).toHaveBeenCalledWith("ask");
  });

  it("dynamically populates models from activeAgent and calls onModelChange", () => {
    const onModelChange = vi.fn();

    render(
      <ComposerDock
        activeAgent={mockAgent}
        selectedModel="Sonnet 5.5"
        selectedEffort="High"
        permissionMode="bypass"
        isThinking={false}
        onSendMessage={() => {}}
        onModelChange={onModelChange}
        onEffortChange={() => {}}
        onPermissionModeChange={() => {}}
      />
    );

    const modelBtn = screen.getByRole("button", { name: /model selector/i });
    expect(modelBtn).toBeDefined();
    expect(screen.getByText("Sonnet 5.5")).toBeDefined();

    fireEvent.click(modelBtn);

    const opusOption = screen.getByRole("button", { name: /select model opus 5\.5/i });
    expect(opusOption).toBeDefined();
    fireEvent.click(opusOption);

    expect(onModelChange).toHaveBeenCalledWith("Opus 5.5");
  });

  it("renders effort dropdown ('High', 'Medium', 'Low') and calls onEffortChange", () => {
    const onEffortChange = vi.fn();

    render(
      <ComposerDock
        activeAgent={mockAgent}
        selectedModel="Sonnet 5.5"
        selectedEffort="High"
        permissionMode="bypass"
        isThinking={false}
        onSendMessage={() => {}}
        onModelChange={() => {}}
        onEffortChange={onEffortChange}
        onPermissionModeChange={() => {}}
      />
    );

    const effortBtn = screen.getByRole("button", { name: /effort selector/i });
    expect(effortBtn).toBeDefined();
    expect(screen.getByText("High")).toBeDefined();

    fireEvent.click(effortBtn);

    const medOption = screen.getByRole("button", { name: /select effort medium/i });
    expect(medOption).toBeDefined();
    fireEvent.click(medOption);

    expect(onEffortChange).toHaveBeenCalledWith("Medium");
  });

  it("renders animated thinking indicator ring when isThinking is true", () => {
    const { rerender } = render(
      <ComposerDock
        activeAgent={mockAgent}
        selectedModel="Sonnet 5.5"
        selectedEffort="High"
        permissionMode="bypass"
        isThinking={false}
        onSendMessage={() => {}}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onPermissionModeChange={() => {}}
      />
    );

    expect(screen.queryByTestId("thinking-indicator-ring")).toBeNull();

    rerender(
      <ComposerDock
        activeAgent={mockAgent}
        selectedModel="Sonnet 5.5"
        selectedEffort="High"
        permissionMode="bypass"
        isThinking={true}
        onSendMessage={() => {}}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onPermissionModeChange={() => {}}
      />
    );

    const ring = screen.getByTestId("thinking-indicator-ring");
    expect(ring).toBeDefined();
    expect(ring.className).toContain("animate-spin");
  });

  it("renders the attachment (+) button", () => {
    render(
      <ComposerDock
        activeAgent={mockAgent}
        selectedModel="Sonnet 5.5"
        selectedEffort="High"
        permissionMode="bypass"
        isThinking={false}
        onSendMessage={() => {}}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        onPermissionModeChange={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: /add attachment/i })).toBeDefined();
  });
});
