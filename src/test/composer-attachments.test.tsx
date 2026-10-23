import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { createRef } from "react";
import { ComposerDock, type ComposerHandle } from "../components/ComposerDock";
import { ChatCanvas } from "../components/ChatCanvas";
import { fakeTauriInvoke } from "./setup";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function prompt(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
}

afterEach(() => vi.restoreAllMocks());

describe("Composer attachments", () => {
  it("keeps attached files as chips and sends them with the message", async () => {
    const onSendMessage = vi.fn();
    const onAttach = vi.fn().mockResolvedValue(["/Users/me/shot.png", "/Users/me/notes.md"]);
    render(<ComposerDock onSendMessage={onSendMessage} onAttach={onAttach} attachAsFiles />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
    });
    expect(prompt().value).toBe("");
    expect(await screen.findByRole("img", { name: "shot.png" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Remove notes.md" }));
    fireEvent.change(prompt(), { target: { value: "what is wrong here?" } });
    fireEvent.keyDown(prompt(), { key: "Enter" });

    expect(onSendMessage).toHaveBeenCalledWith("what is wrong here?", ["/Users/me/shot.png"]);
    expect(screen.queryByRole("img", { name: "shot.png" })).toBeNull();
  });

  it("can send attachments without text", async () => {
    const onSendMessage = vi.fn();
    const ref = createRef<ComposerHandle>();
    render(<ComposerDock onSendMessage={onSendMessage} attachAsFiles handleRef={ref} />);

    act(() => ref.current?.insertPaths(["/Users/me/error.png"]));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSendMessage).toHaveBeenCalledWith("", ["/Users/me/error.png"]);
  });

  it("puts attached paths in the text for a terminal agent", async () => {
    const onAttach = vi.fn().mockResolvedValue(["/Users/me/notes.md"]);
    render(<ComposerDock onSendMessage={() => {}} onAttach={onAttach} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
    });

    expect(prompt().value).toBe("/Users/me/notes.md ");
  });

  it("shows an image attachment as a thumbnail and other files as chips", async () => {
    const onAttach = vi.fn().mockResolvedValue(["/Users/me/shot.png", "/Users/me/notes.md"]);
    render(<ComposerDock onSendMessage={() => {}} onAttach={onAttach} attachAsFiles />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
    });

    expect(await screen.findByRole("img", { name: "shot.png" })).toBeDefined();
    expect(screen.getByText("notes.md")).toBeDefined();
    expect(screen.queryByText("shot.png")).toBeNull();
  });

  it("removes an attached image with its remove button", async () => {
    const onAttach = vi.fn().mockResolvedValue(["/Users/me/shot.png", "/Users/me/notes.md"]);
    render(<ComposerDock onSendMessage={() => {}} onAttach={onAttach} attachAsFiles />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
    });
    expect(await screen.findByRole("img", { name: "shot.png" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));

    expect(screen.queryByRole("img", { name: "shot.png" })).toBeNull();
    expect(screen.getByText("notes.md")).toBeDefined();
  });

  it("falls back to a chip that says the image is missing", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "attachment_preview" ? Promise.reject("Cannot preview /Users/me/gone.png: No such file") : fakeTauriInvoke(cmd, args),
    );
    const onAttach = vi.fn().mockResolvedValue(["/Users/me/gone.png"]);
    render(<ComposerDock onSendMessage={() => {}} onAttach={onAttach} attachAsFiles />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
    });

    expect(await screen.findByText("Image not found")).toBeDefined();
    expect(screen.getByText("gone.png")).toBeDefined();
    expect(screen.queryByRole("img", { name: "gone.png" })).toBeNull();
  });
});

describe("Image attachments in a sent message", () => {
  it("shows the image as a thumbnail above the text that opens larger", async () => {
    render(
      <ChatCanvas
        messages={[
          {
            id: "m-1",
            role: "user",
            content: "what is wrong here?",
            timestamp: 1,
            attachments: ["/Users/me/shot.png"],
          },
        ]}
      />,
    );

    const thumbnail = await screen.findByRole("img", { name: "shot.png" });
    expect(thumbnail.closest("button")?.getAttribute("aria-label")).toBe("Open shot.png");

    fireEvent.click(screen.getByRole("button", { name: "Open shot.png" }));

    const dialog = screen.getByRole("dialog", { name: "shot.png" });
    expect(within(dialog).getByRole("img", { name: "shot.png" })).toBeDefined();
  });
});
