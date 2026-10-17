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

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

async function typeInPrompt(text: string) {
  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: text } });
  });
}

describe("Dropping files onto the window", () => {
  it("shows where files will go while they are dragged, and puts dropped paths into the prompt", async () => {
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
    const prompt = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
    expect(prompt.value).toBe('/Users/test/shot.png "/Users/test/my notes.md" ');
  });

  it("types dropped files into a live terminal agent's screen", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");
    await act(async () => {
      render(<App />);
    });
    await typeInPrompt("get started");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Prompt" }), { key: "Enter" });
    });
    const sessionId = (spy.mock.calls.find(([cmd]) => cmd === "spawn_session")?.[1] as { sessionId: string }).sessionId;

    await act(async () => {
      dragHandler({ payload: { type: "drop", paths: ["/Users/test/shot.png"] } });
    });

    expect(spy).toHaveBeenCalledWith("send_input", { sessionId, data: "/Users/test/shot.png " }, undefined);
    spy.mockRestore();
  });

  it("lists the session folder's files after an @ in the prompt", async () => {
    const original = tauriInternals().invoke;
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "workspace_files" ? Promise.resolve(["src/App.tsx", "README.md"]) : original(cmd, args)
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
});
