import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ComposerDock } from "../components/ComposerDock";
import type { ComposerControls } from "../lib/composer-controls";

function prompt(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
}

function controls(overrides: Partial<ComposerControls> = {}): ComposerControls {
  return {
    permission: {
      options: [
        { value: "default", label: "Default" },
        { value: "yolo", label: "YOLO" },
      ],
      selected: "default",
      onChange: vi.fn(),
    },
    model: {
      options: [
        { value: undefined, label: "Default model" },
        { value: "opus", label: "opus" },
      ],
      selected: undefined,
      onChange: vi.fn(),
    },
    ...overrides,
  };
}

describe("ComposerDock", () => {
  it("renders no usage banner, Upgrade or voice controls (no data source exists for them)", () => {
    render(<ComposerDock controls={controls()} onSendMessage={() => {}} />);

    expect(screen.queryByText(/usage limit/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /voice dictation/i })).toBeNull();
  });

  describe("sending", () => {
    it("submits on Enter without Shift and clears the input", () => {
      const onSendMessage = vi.fn();
      render(<ComposerDock onSendMessage={onSendMessage} />);

      fireEvent.change(prompt(), { target: { value: "  fix the build  " } });
      fireEvent.keyDown(prompt(), { key: "Enter" });

      expect(onSendMessage).toHaveBeenCalledWith("fix the build");
      expect(prompt().value).toBe("");
    });

    it("keeps Shift+Enter for a newline instead of sending", () => {
      const onSendMessage = vi.fn();
      render(<ComposerDock onSendMessage={onSendMessage} />);

      fireEvent.change(prompt(), { target: { value: "line one" } });
      fireEvent.keyDown(prompt(), { key: "Enter", shiftKey: true });

      expect(onSendMessage).not.toHaveBeenCalled();
    });

    it("sends with the Send button and ignores whitespace-only input", () => {
      const onSendMessage = vi.fn();
      render(<ComposerDock onSendMessage={onSendMessage} />);

      fireEvent.change(prompt(), { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      expect(onSendMessage).not.toHaveBeenCalled();

      fireEvent.change(prompt(), { target: { value: "run tests" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      expect(onSendMessage).toHaveBeenCalledWith("run tests");
    });
  });

  describe("controls", () => {
    it("shows the given permission choices and reports a pick", () => {
      const c = controls();
      render(<ComposerDock controls={c} onSendMessage={() => {}} />);

      fireEvent.click(screen.getByRole("button", { name: /permission mode: default/i }));
      fireEvent.click(screen.getByRole("option", { name: "YOLO" }));

      expect(c.permission?.onChange).toHaveBeenCalledWith("yolo");
    });

    it("warns visually when a risky mode is selected", () => {
      const c = controls();
      const { rerender } = render(<ComposerDock controls={c} onSendMessage={() => {}} />);
      expect(screen.queryByTestId("risky-permission-icon")).toBeNull();

      rerender(
        <ComposerDock
          controls={{ ...c, permission: { ...c.permission!, selected: "yolo" } }}
          onSendMessage={() => {}}
        />
      );
      expect(screen.getByTestId("risky-permission-icon")).toBeDefined();
    });

    it("reports a model pick, including the default that passes no flag", () => {
      const c = controls();
      render(<ComposerDock controls={c} onSendMessage={() => {}} />);

      fireEvent.click(screen.getByRole("button", { name: /model: default model/i }));
      fireEvent.click(screen.getByRole("option", { name: "opus" }));

      expect(c.model?.onChange).toHaveBeenCalledWith("opus");
    });

    it("renders only the controls it is given", () => {
      render(<ComposerDock controls={{ model: controls().model }} onSendMessage={() => {}} />);

      expect(screen.queryByRole("button", { name: /permission mode/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /^effort:/i })).toBeNull();
      expect(screen.getByRole("button", { name: /^model:/i })).toBeDefined();
    });

    it("locks the controls with an explanation when asked", () => {
      render(<ComposerDock controls={controls()} optionsLocked onSendMessage={() => {}} />);

      const model = screen.getByRole("button", { name: /^model:/i }) as HTMLButtonElement;
      expect(model.disabled).toBe(true);
      expect(model.title).toMatch(/new session/i);
    });
  });

  describe("while the agent works", () => {
    it("shows a Stop button in place of Send; the working indicator lives in the conversation", () => {
      const onStop = vi.fn();
      render(<ComposerDock isThinking onStop={onStop} onSendMessage={() => {}} />);

      expect(screen.queryByTestId("thinking-indicator-ring")).toBeNull();
      expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("shows no Stop when idle", () => {
      render(<ComposerDock onStop={() => {}} onSendMessage={() => {}} />);

      expect(screen.queryByRole("button", { name: "Stop agent" })).toBeNull();
    });
  });

  describe("context usage", () => {
    it("shows how much of the agent's context window is used", () => {
      render(<ComposerDock onSendMessage={() => {}} contextUsage={{ used: 74_485, size: 1_000_000 }} />);

      const meter = screen.getByRole("meter", { name: "Context used" });
      expect(meter.getAttribute("aria-valuenow")).toBe("7");
      expect(meter.textContent).toContain("7%");
      expect(meter.getAttribute("title")).toContain("74,485 of 1,000,000 tokens");
    });

    it("hides the meter until the agent reports usage", () => {
      render(<ComposerDock onSendMessage={() => {}} />);

      expect(screen.queryByRole("meter", { name: "Context used" })).toBeNull();
    });
  });

  it("inserts picked attachment paths into the prompt, quoting paths with spaces", async () => {
    const onAttach = vi.fn().mockResolvedValue(["/repo/src/app.ts", "/repo/my notes.md"]);
    render(<ComposerDock onSendMessage={() => {}} onAttach={onAttach} />);

    fireEvent.change(prompt(), { target: { value: "review" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
    });

    expect(prompt().value).toBe('review /repo/src/app.ts "/repo/my notes.md" ');
  });

  it("hides the attachment button when no picker is wired", () => {
    render(<ComposerDock onSendMessage={() => {}} />);

    expect(screen.queryByRole("button", { name: "Add attachment" })).toBeNull();
  });
});
