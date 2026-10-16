import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ComposerDock } from "../components/ComposerDock";
import { claudeProfile, ompProfile } from "./fixtures/agents";

function prompt(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
}

describe("ComposerDock", () => {
  it("renders no usage banner, Upgrade or voice controls (no data source exists for them)", () => {
    render(<ComposerDock activeAgent={claudeProfile} onSendMessage={() => {}} />);

    expect(screen.queryByText(/usage limit/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /voice dictation/i })).toBeNull();
  });

  describe("sending", () => {
    it("submits on Enter without Shift and clears the input", () => {
      const onSendMessage = vi.fn();
      render(<ComposerDock activeAgent={claudeProfile} onSendMessage={onSendMessage} />);

      fireEvent.change(prompt(), { target: { value: "  fix the build  " } });
      fireEvent.keyDown(prompt(), { key: "Enter" });

      expect(onSendMessage).toHaveBeenCalledWith("fix the build");
      expect(prompt().value).toBe("");
    });

    it("keeps Shift+Enter for a newline instead of sending", () => {
      const onSendMessage = vi.fn();
      render(<ComposerDock activeAgent={claudeProfile} onSendMessage={onSendMessage} />);

      fireEvent.change(prompt(), { target: { value: "line one" } });
      fireEvent.keyDown(prompt(), { key: "Enter", shiftKey: true });

      expect(onSendMessage).not.toHaveBeenCalled();
    });

    it("sends with the Send button and ignores whitespace-only input", () => {
      const onSendMessage = vi.fn();
      render(<ComposerDock activeAgent={claudeProfile} onSendMessage={onSendMessage} />);

      fireEvent.change(prompt(), { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      expect(onSendMessage).not.toHaveBeenCalled();

      fireEvent.change(prompt(), { target: { value: "run tests" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      expect(onSendMessage).toHaveBeenCalledWith("run tests");
    });
  });

  describe("agent options", () => {
    it("lists the agent's own permission modes and defaults to the safe one", () => {
      const onPermissionModeChange = vi.fn();
      render(
        <ComposerDock
          activeAgent={claudeProfile}
          onSendMessage={() => {}}
          onPermissionModeChange={onPermissionModeChange}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /permission mode: ask every time/i }));
      fireEvent.click(screen.getByRole("option", { name: "Plan mode" }));

      expect(onPermissionModeChange).toHaveBeenCalledWith("plan");
    });

    it("offers the agent's models plus a default that passes no flag", () => {
      const onModelChange = vi.fn();
      render(
        <ComposerDock
          activeAgent={claudeProfile}
          selectedModel="sonnet"
          onSendMessage={() => {}}
          onModelChange={onModelChange}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /model: sonnet/i }));
      fireEvent.click(screen.getByRole("option", { name: "opus" }));
      expect(onModelChange).toHaveBeenLastCalledWith("opus");

      fireEvent.click(screen.getByRole("button", { name: /model: sonnet/i }));
      fireEvent.click(screen.getByRole("option", { name: "Default model" }));
      expect(onModelChange).toHaveBeenLastCalledWith(undefined);
    });

    it("offers the agent's effort levels", () => {
      const onEffortChange = vi.fn();
      render(
        <ComposerDock activeAgent={claudeProfile} onSendMessage={() => {}} onEffortChange={onEffortChange} />
      );

      fireEvent.click(screen.getByRole("button", { name: /effort: default effort/i }));
      fireEvent.click(screen.getByRole("option", { name: "high" }));

      expect(onEffortChange).toHaveBeenCalledWith("high");
    });

    it("hides selectors the agent has no real options for", () => {
      render(<ComposerDock activeAgent={ompProfile} onSendMessage={() => {}} />);

      expect(screen.queryByRole("button", { name: /^model:/i })).toBeNull();
      expect(screen.getByRole("button", { name: /^effort:/i })).toBeDefined();
    });

    it("locks the options while a session runs, because CLI flags only apply at start", () => {
      render(<ComposerDock activeAgent={claudeProfile} optionsLocked onSendMessage={() => {}} />);

      const permission = screen.getByRole("button", { name: /permission mode/i }) as HTMLButtonElement;
      const model = screen.getByRole("button", { name: /^model:/i }) as HTMLButtonElement;
      expect(permission.disabled).toBe(true);
      expect(model.disabled).toBe(true);
      expect(model.title).toMatch(/new session/i);
    });
  });

  it("inserts picked attachment paths into the prompt, quoting paths with spaces", async () => {
    const onAttach = vi.fn().mockResolvedValue(["/repo/src/app.ts", "/repo/my notes.md"]);
    render(<ComposerDock activeAgent={claudeProfile} onSendMessage={() => {}} onAttach={onAttach} />);

    fireEvent.change(prompt(), { target: { value: "review" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
    });

    expect(prompt().value).toBe('review /repo/src/app.ts "/repo/my notes.md" ');
  });

  it("hides the attachment button when no picker is wired", () => {
    render(<ComposerDock activeAgent={claudeProfile} onSendMessage={() => {}} />);

    expect(screen.queryByRole("button", { name: "Add attachment" })).toBeNull();
  });

  it("shows the thinking indicator only while the agent is busy", () => {
    const { rerender } = render(<ComposerDock activeAgent={claudeProfile} onSendMessage={() => {}} />);
    expect(screen.queryByTestId("thinking-indicator-ring")).toBeNull();

    rerender(<ComposerDock activeAgent={claudeProfile} isThinking onSendMessage={() => {}} />);
    expect(screen.getByTestId("thinking-indicator-ring")).toBeDefined();
  });
});
