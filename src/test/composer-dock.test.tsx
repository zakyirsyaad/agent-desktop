import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { createRef } from "react";
import { ComposerDock, type ComposerHandle } from "../components/ComposerDock";
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

    it("with sendDisabled, keeps the prompt and attach usable but does not send", () => {
      const onSendMessage = vi.fn();
      render(<ComposerDock onSendMessage={onSendMessage} onAttach={async () => []} sendDisabled />);

      expect(prompt().disabled).toBe(false);
      expect((screen.getByRole("button", { name: "Add attachment" }) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.change(prompt(), { target: { value: "fix the build" } });
      expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.keyDown(prompt(), { key: "Enter" });

      expect(onSendMessage).not.toHaveBeenCalled();
      expect(prompt().value).toBe("fix the build");
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

    it("draws no arc at 0%, and shows just the token count when the window size is unknown", () => {
      const { container, rerender } = render(
        <ComposerDock onSendMessage={() => {}} contextUsage={{ used: 2_000, size: 1_000_000 }} />
      );
      expect(container.querySelectorAll("svg circle")).toHaveLength(1);

      rerender(<ComposerDock onSendMessage={() => {}} contextUsage={{ used: 180_000, size: 0 }} />);
      expect(screen.queryByRole("meter", { name: "Context used" })).toBeNull();
      // Named, but not a live region: usage updates are not announced one by one.
      const fallback = screen.getByRole("img", { name: "Context used: 180K tokens" });
      expect(fallback.textContent).toBe("180K tokens");
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

  it("reopens the folder list unfiltered after it was dismissed with a search typed", () => {
    const folders = [
      { name: "api", path: "/w/api" },
      { name: "web", path: "/w/web" },
    ];
    render(<ComposerDock onSendMessage={() => {}} folder={{ folders, selectedPath: "/w/api", onSelect: () => {} }} />);
    const chip = screen.getByRole("button", { name: "Folder: api" });

    fireEvent.click(chip);
    fireEvent.change(screen.getByRole("textbox", { name: "Search folders" }), { target: { value: "xyz" } });
    expect(screen.getByText("No folder matches.")).toBeDefined();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Choose a folder" })).toBeNull();
    fireEvent.click(chip);

    expect((screen.getByRole("textbox", { name: "Search folders" }) as HTMLInputElement).value).toBe("");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["api", "web"]);
  });

  it("marks a worktree in place of the folder icon, so the chip keeps its width", () => {
    const folder = (isOn: boolean) => ({
      folders: [{ name: "api", path: "/w/api" }],
      selectedPath: "/w/api",
      onSelect: () => {},
      worktree: { isOn, onChange: () => {} },
    });
    const { rerender } = render(<ComposerDock onSendMessage={() => {}} folder={folder(false)} />);
    const chip = () => screen.getByRole("button", { name: "Folder: api" });
    const iconCountOff = chip().querySelectorAll("svg").length;

    rerender(<ComposerDock onSendMessage={() => {}} folder={folder(true)} />);

    expect(chip().querySelectorAll("svg").length).toBe(iconCountOff);
    expect(chip().querySelector('[aria-label="in a new worktree"]')).not.toBeNull();
  });

  it("closes an open dropdown with Escape", () => {
    render(<ComposerDock onSendMessage={() => {}} controls={controls()} />);

    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    expect(screen.getByRole("listbox", { name: "Model" })).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("listbox", { name: "Model" })).toBeNull();
  });

  it("shows a model's own name on the chip, its provider in the list and the tooltip", () => {
    render(
      <ComposerDock
        onSendMessage={() => {}}
        controls={controls({
          model: {
            options: [
              { value: "a", label: "[ModelStudio Token Plan] qwen3.8-max" },
              { value: "b", label: "[ModelStudio Token Plan] qwen3-coder" },
            ],
            selected: "a",
            onChange: vi.fn(),
          },
        })}
      />
    );

    const chip = screen.getByRole("button", { name: /^Model:/ });
    expect(chip.textContent).toBe("qwen3.8-max");
    expect(chip.getAttribute("title")).toBe("[ModelStudio Token Plan] qwen3.8-max");
    fireEvent.click(chip);
    expect(screen.getByRole("option", { name: "[ModelStudio Token Plan] qwen3-coder" })).toBeDefined();
  });
});

describe("ComposerDock restored message", () => {
  function renderWithHandle() {
    const handle = createRef<ComposerHandle>();
    render(<ComposerDock handleRef={handle} onSendMessage={() => {}} />);
    return handle;
  }

  it("holds the restored message until the user changes it", () => {
    const handle = renderWithHandle();

    act(() => handle.current?.restore("hi"));
    expect(handle.current?.holdsRestored()).toBe(true);

    fireEvent.change(prompt(), { target: { value: "hi!" } });
    expect(handle.current?.holdsRestored()).toBe(false);
  });

  it("is emptied by clear and then holds nothing restored", () => {
    const handle = renderWithHandle();
    act(() => handle.current?.restore("hi"));

    act(() => handle.current?.clear());

    expect(prompt().value).toBe("");
    expect(handle.current?.holdsRestored()).toBe(false);
  });
});
