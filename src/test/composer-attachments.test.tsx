import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { createRef } from "react";
import { ComposerDock, type ComposerHandle } from "../components/ComposerDock";

function prompt(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
}

describe("Composer attachments", () => {
  it("keeps attached files as chips and sends them with the message", async () => {
    const onSendMessage = vi.fn();
    const onAttach = vi.fn().mockResolvedValue(["/Users/me/shot.png", "/Users/me/notes.md"]);
    render(<ComposerDock onSendMessage={onSendMessage} onAttach={onAttach} attachAsFiles />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
    });
    expect(prompt().value).toBe("");
    expect(screen.getByText("shot.png")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Remove notes.md" }));
    fireEvent.change(prompt(), { target: { value: "what is wrong here?" } });
    fireEvent.keyDown(prompt(), { key: "Enter" });

    expect(onSendMessage).toHaveBeenCalledWith("what is wrong here?", ["/Users/me/shot.png"]);
    expect(screen.queryByText("shot.png")).toBeNull();
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
});
