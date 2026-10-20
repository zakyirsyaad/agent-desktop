import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

type DragHandler = (event: { payload: { type: string; paths?: string[] } }) => void;
let dragHandler: DragHandler = () => {};

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: DragHandler) => {
      dragHandler = handler;
      return Promise.resolve(() => {});
    },
  }),
}));

import App from "../App";
import { fakeTauriInvoke } from "./setup";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

/** The paths of the files attached to the message, in order. */
function attachedPaths(): (string | null)[] {
  const list = screen.getByRole("list", { name: "Attachments" });
  return within(list).getAllByRole("listitem").map((item) => item.getAttribute("title"));
}

async function typeInPrompt(text: string) {
  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: text } });
  });
}

describe("Dropping files onto the window", () => {
  it("shows where files will go while they are dragged, and attaches dropped files to the message", async () => {
    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      dragHandler({ payload: { type: "enter", paths: ["/Users/test/shot.png"] } });
    });
    expect(screen.getByText("Drop files to add them to your message")).toBeDefined();

    await act(async () => {
      dragHandler({ payload: { type: "drop", paths: ["/Users/test/shot.png", "/Users/test/my notes.md"] } });
    });

    expect(screen.queryByText("Drop files to add them to your message")).toBeNull();
    expect(attachedPaths()).toEqual(["/Users/test/shot.png", "/Users/test/my notes.md"]);
    expect((screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("lists the session folder's files after an @ in the prompt", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "workspace_files" ? Promise.resolve(["src/App.tsx", "README.md"]) : fakeTauriInvoke(cmd, args)
    );
    await act(async () => {
      render(<App />);
    });

    await typeInPrompt("fix @app");

    expect(spy).toHaveBeenCalledWith("workspace_files", { root: "/Users/test/developer/ai-perpetual-trading" }, undefined);
    const files = within(screen.getByRole("listbox", { name: "Files to mention" }));
    expect(files.getAllByRole("option").map((o) => o.getAttribute("data-file"))).toEqual(["src/App.tsx"]);
    spy.mockRestore();
  });

  it("leaves out a dropped file whose name has control characters, and says so", async () => {
    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      dragHandler({ payload: { type: "drop", paths: ["/Users/test/ok.md", "/Users/test/evil\rname.md"] } });
    });

    expect(attachedPaths()).toEqual(["/Users/test/ok.md"]);
    expect(screen.getByRole("alert").textContent).toContain("control characters");
  });
});
