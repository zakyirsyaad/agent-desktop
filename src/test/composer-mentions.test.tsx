import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { ComposerDock } from "../components/ComposerDock";

const FILES = ["README.md", "src/App.tsx", "src/app-info.ts", "src/my file.ts"];

function prompt(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
}

/** Types as a user does: setting the value puts the caret after the text. */
async function type(text: string) {
  await act(async () => {
    fireEvent.change(prompt(), { target: { value: text } });
  });
}

function renderComposer(attachAsFiles: boolean, onSendMessage = vi.fn()) {
  const loadFiles = vi.fn().mockResolvedValue(FILES);
  render(
    <ComposerDock
      onSendMessage={onSendMessage}
      attachAsFiles={attachAsFiles}
      mentions={{ root: "/w/api", loadFiles }}
    />
  );
  return { loadFiles, onSendMessage };
}

describe("Composer @-mentions", () => {
  it("lists matching workspace files after an @, reading them once", async () => {
    const { loadFiles } = renderComposer(true);

    await type("fix @ap");
    await type("fix @app");

    const menu = within(screen.getByRole("listbox", { name: "Files to mention" }));
    expect(menu.getAllByRole("option").map((o) => o.getAttribute("data-file"))).toEqual(["src/App.tsx", "src/app-info.ts"]);
    expect(loadFiles).toHaveBeenCalledTimes(1);
  });

  it("attaches the picked file for an agent that takes files, and drops the @word", async () => {
    const { onSendMessage } = renderComposer(true);
    await type("look at @app");

    fireEvent.keyDown(prompt(), { key: "ArrowDown" });
    fireEvent.keyDown(prompt(), { key: "Enter" });

    expect(prompt().value).toBe("look at ");
    expect(screen.getByText("app-info.ts")).toBeDefined();
    expect(screen.queryByRole("listbox", { name: "Files to mention" })).toBeNull();
    fireEvent.keyDown(prompt(), { key: "Enter" });
    expect(onSendMessage).toHaveBeenCalledWith("look at", ["/w/api/src/app-info.ts"]);
  });

  it("writes the picked file's path in place for a terminal agent, quoted when it has spaces", async () => {
    renderComposer(false);
    await type("open @my");

    await act(async () => {
      fireEvent.mouseDown(screen.getByRole("option", { name: /my file\.ts/ }));
    });

    expect(prompt().value).toBe('open "/w/api/src/my file.ts" ');
  });

  it("closes the list with Escape, and offers none for an email address", async () => {
    renderComposer(true);
    await type("@app");
    fireEvent.keyDown(prompt(), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Files to mention" })).toBeNull();

    await type("mail me@app");
    expect(screen.queryByRole("listbox", { name: "Files to mention" })).toBeNull();
  });

  it("keeps a workspace's files when an earlier workspace's list arrives later", async () => {
    let finishA: (files: string[]) => void = () => {};
    const loadA = vi.fn(() => new Promise<string[]>((resolve) => (finishA = resolve)));
    const loadB = vi.fn().mockResolvedValue(["b/bravo.ts"]);
    const { rerender } = render(<ComposerDock onSendMessage={() => {}} mentions={{ root: "/w/a", loadFiles: loadA }} />);
    await type("@a");

    rerender(<ComposerDock onSendMessage={() => {}} mentions={{ root: "/w/b", loadFiles: loadB }} />);
    await type("@br");
    await act(async () => {
      finishA(["a/alpha.ts"]);
    });

    // Without typing again: the late list for A must not hide B's.
    const menu = within(screen.getByRole("listbox", { name: "Files to mention" }));
    expect(menu.getAllByRole("option").map((o) => o.getAttribute("data-file"))).toEqual(["b/bravo.ts"]);
  });

  it("closes the list when the caret leaves the @word, so Enter sends the message", async () => {
    const { onSendMessage } = renderComposer(true);
    await type("@app fix this");
    await act(async () => {
      prompt().setSelectionRange(2, 2);
      fireEvent.keyUp(prompt(), { key: "ArrowLeft" });
    });
    expect(screen.getByRole("listbox", { name: "Files to mention" })).toBeDefined();

    await act(async () => {
      prompt().setSelectionRange(13, 13);
      fireEvent.keyUp(prompt(), { key: "ArrowRight" });
    });
    expect(screen.queryByRole("listbox", { name: "Files to mention" })).toBeNull();
    fireEvent.keyDown(prompt(), { key: "Enter" });

    expect(onSendMessage).toHaveBeenCalledWith("@app fix this", []);
  });

  it("closes the list when the message is sent with the button", async () => {
    renderComposer(false);
    await type("@app");

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(screen.queryByRole("listbox", { name: "Files to mention" })).toBeNull();
  });
});
