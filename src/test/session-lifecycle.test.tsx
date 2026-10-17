import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
import type { FakeTauriStore } from "./setup";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
}));

import App from "../App";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

function seedSession(id: string, name: string, createdAt: number) {
  return {
    id,
    name,
    profileId: "claude-code",
    cwd: "/Users/test/developer/agent-desktop",
    status: "terminated",
    createdAt,
  };
}

async function renderApp() {
  await act(async () => {
    render(<App />);
  });
}

async function startNewSession(): Promise<string> {
  const spy = vi.spyOn(tauriInternals(), "invoke");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
  });
  const spawnCall = spy.mock.calls.find(([cmd]) => cmd === "spawn_session");
  return (spawnCall?.[1] as { sessionId: string }).sessionId;
}

function sidebar() {
  return within(screen.getByRole("complementary"));
}

function sessionRow(name: string): HTMLElement {
  return sidebar().getByText(name).closest("li") as HTMLElement;
}

describe("Session lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
  });

  it("restores saved sessions and loads a session's transcript when it is selected", async () => {
    fakeStore().state.sessions = [
      seedSession("s-old", "Refactor parser", 1000),
      seedSession("s-new", "Fix login", 2000),
    ];
    fakeStore().transcripts["s-old"] = [
      { id: "m-1", role: "user", content: "hello from disk", timestamp: 1 },
    ];

    await renderApp();

    expect(sidebar().getByText("Fix login")).toBeDefined();
    await act(async () => {
      fireEvent.click(sidebar().getByText("Refactor parser"));
    });
    expect(await screen.findByText("hello from disk")).toBeDefined();
  });

  it("persists a newly started session", async () => {
    await renderApp();
    await startNewSession();

    await waitFor(() => {
      const saved = fakeStore().state.sessions as { cwd: string }[];
      expect(saved).toHaveLength(1);
      expect(saved[0].cwd).toBe("/Users/test/developer/ai-perpetual-trading");
    });
  });

  it("offers Stop only while the agent works, and stops its turn with Ctrl+C", async () => {
    await renderApp();
    const sessionId = await startNewSession();
    const row = () => sessionRow("Session #1");
    expect(within(row()).queryByRole("button", { name: "Stop session" })).toBeNull();
    expect(within(row()).queryByLabelText("Agent working")).toBeNull();

    await act(async () => {
      listeners.get("pty-output")?.({ payload: { session_id: sessionId, data: "Thinking...\r\n" } });
    });
    expect(within(row()).getByLabelText("Agent working")).toBeDefined();
    const spy = vi.spyOn(tauriInternals(), "invoke");
    await act(async () => {
      fireEvent.click(within(row()).getByRole("button", { name: "Stop session" }));
    });

    expect(spy).toHaveBeenCalledWith("send_input", { sessionId, data: "\x03" }, undefined);
  });

  it("marks a session ended when its agent process exits", async () => {
    await renderApp();
    const sessionId = await startNewSession();

    await act(async () => {
      listeners.get("pty-exit")?.({ payload: { session_id: sessionId, exit_code: 0 } });
    });

    await waitFor(() => {
      const [saved] = fakeStore().state.sessions as { status: string }[];
      expect(saved.status).toBe("terminated");
    });
    expect(within(sessionRow("Session #1")).getByRole("button", { name: "Delete session" })).toBeDefined();
  });

  it("stops a live session's agent before deleting it", async () => {
    await renderApp();
    const sessionId = await startNewSession();
    const spy = vi.spyOn(tauriInternals(), "invoke");

    await act(async () => {
      fireEvent.click(within(sessionRow("Session #1")).getByRole("button", { name: "Delete session" }));
    });

    expect(spy).toHaveBeenCalledWith("terminate_session", { sessionId }, undefined);
    expect(sidebar().queryByText("Session #1")).toBeNull();
  });

  it("does not bring back a deleted terminal session's transcript from its last output", async () => {
    await renderApp();
    const sessionId = await startNewSession();
    const spy = vi.spyOn(tauriInternals(), "invoke");

    await act(async () => {
      fireEvent.click(within(sessionRow("Session #1")).getByRole("button", { name: "Delete session" }));
    });
    await act(async () => {
      listeners.get("pty-output")?.({ payload: { session_id: sessionId, data: "Goodbye\r\n" } });
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(spy.mock.calls.filter(([cmd, args]) => cmd === "save_transcript" && (args as { sessionId?: string })?.sessionId === sessionId)).toHaveLength(0);
  });

  it("shows a terminal agent's real screen instead of a chat, and takes input there", async () => {
    await renderApp();
    await startNewSession();

    expect(screen.getByTestId("terminal-view")).toBeDefined();
    const composer = screen.getByRole("textbox", { name: "Prompt" });
    expect(composer.closest(".hidden")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "No session yet" })).toBeNull();
  });

  it("deletes an ended session and its transcript", async () => {
    fakeStore().state.sessions = [seedSession("s-old", "Refactor parser", 1000)];
    fakeStore().transcripts["s-old"] = [];
    await renderApp();
    const spy = vi.spyOn(tauriInternals(), "invoke");

    await act(async () => {
      fireEvent.click(within(sessionRow("Refactor parser")).getByRole("button", { name: "Delete session" }));
    });

    expect(sidebar().queryByText("Refactor parser")).toBeNull();
    expect(spy).toHaveBeenCalledWith("delete_transcript", { sessionId: "s-old" }, undefined);
  });

  it("starts a new session from the composer when the active one has ended", async () => {
    fakeStore().state.sessions = [seedSession("s-old", "Refactor parser", 1000)];
    await renderApp();
    const spy = vi.spyOn(tauriInternals(), "invoke");

    const composer = screen.getByPlaceholderText(/start a new session/i) as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);
    await act(async () => {
      fireEvent.change(composer, { target: { value: "run the tests" } });
      fireEvent.keyDown(composer, { key: "Enter" });
    });

    expect(spy.mock.calls.some(([cmd]) => cmd === "spawn_session")).toBe(true);
    expect(sidebar().getByText("run the tests")).toBeDefined();
  });

  it("shows an alert and does not append the message when sending fails", async () => {
    await renderApp();
    await startNewSession();
    const original = tauriInternals().invoke;
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "send_input" ? Promise.reject("Session 's-x' not found") : original(cmd, args)
    );

    const composer = screen.getByRole("textbox", { name: /prompt/i });
    await act(async () => {
      fireEvent.change(composer, { target: { value: "please run the tests" } });
      fireEvent.keyDown(composer, { key: "Enter" });
    });

    expect(screen.getByRole("alert").textContent).toContain("Failed to send input");
    expect(screen.queryByText("please run the tests")).toBeNull();
  });
});
