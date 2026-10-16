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

  it("marks a session ended when its agent process exits", async () => {
    await renderApp();
    const sessionId = await startNewSession();
    const row = sessionRow("Session #1");
    expect(within(row).getByRole("button", { name: "Stop session" })).toBeDefined();

    await act(async () => {
      listeners.get("pty-exit")?.({ payload: { session_id: sessionId, exit_code: 0 } });
    });

    expect(within(row).queryByRole("button", { name: "Stop session" })).toBeNull();
    expect(within(row).getByRole("button", { name: "Delete session" })).toBeDefined();
  });

  it("stops a running session through terminate_session", async () => {
    await renderApp();
    const sessionId = await startNewSession();
    const spy = vi.spyOn(tauriInternals(), "invoke");

    await act(async () => {
      fireEvent.click(within(sessionRow("Session #1")).getByRole("button", { name: "Stop session" }));
    });

    expect(spy).toHaveBeenCalledWith("terminate_session", { sessionId }, undefined);
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

  it("disables the composer when the active session is not running", async () => {
    fakeStore().state.sessions = [seedSession("s-old", "Refactor parser", 1000)];
    await renderApp();

    const composer = screen.getByPlaceholderText("Start a session to send a message");
    expect((composer as HTMLTextAreaElement).disabled).toBe(true);
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
