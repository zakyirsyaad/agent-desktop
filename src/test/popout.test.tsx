import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener[]>();
const emitted: { event: string; payload: unknown }[] = [];
/** Events sent to one window by label, and events broadcast to every window. */
const sentTo: { target: string; event: string }[] = [];
const broadcast: string[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    return Promise.resolve(() => {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== cb));
    });
  },
  emit: (event: string, payload: unknown) => {
    emitted.push({ event, payload });
    broadcast.push(event);
    return Promise.resolve();
  },
  emitTo: (target: string, event: string, payload: unknown) => {
    emitted.push({ event, payload });
    sentTo.push({ target, event });
    return Promise.resolve();
  },
}));

import App from "../App";
import { PopoutApp } from "../components/PopoutApp";
import { readWindowMode } from "../lib/window-mode";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

async function deliver(event: string, payload: unknown) {
  await act(async () => {
    (listeners.get(event) ?? []).forEach((cb) => cb({ payload }));
  });
}

const runningSession = {
  id: "s-1",
  name: "Fix login",
  profileId: "claude-acp",
  cwd: "/Users/test/developer/zorvo",
  status: "running",
  createdAt: 1,
  transport: "acp",
};

/** Starts a session in the main window with its first message; resolves with its id. */
async function startSessionInMainWindow(spy: { mock: { calls: unknown[][] } }): Promise<string> {
  await act(async () => {
    render(<App />);
  });
  const prompt = screen.getByRole("textbox", { name: "Prompt" });
  await act(async () => {
    fireEvent.change(prompt, { target: { value: "get started" } });
    fireEvent.keyDown(prompt, { key: "Enter" });
  });
  const start = spy.mock.calls.find(([cmd]) => cmd === "acp_start_session");
  return (start?.[1] as { sessionId: string }).sessionId;
}

describe("Popout windows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
    emitted.length = 0;
    sentTo.length = 0;
    broadcast.length = 0;
  });

  it("reads the popout session from the window URL and rejects unsafe ids", () => {
    expect(readWindowMode("?session=s-1&popout=1")).toEqual({ kind: "popout", sessionId: "s-1" });
    expect(readWindowMode("")).toEqual({ kind: "main" });
    expect(readWindowMode("?session=../x&popout=1")).toEqual({ kind: "main" });
  });

  it("renders the snapshot the main window sends and forwards user actions to it", async () => {
    await act(async () => {
      render(<PopoutApp sessionId="s-1" />);
    });
    expect(emitted).toContainEqual({ event: "popout-ready", payload: { sessionId: "s-1" } });

    await deliver("session-snapshot", {
      sessionId: "s-1",
      session: runningSession,
      messages: [{ id: "m-1", role: "agent", content: "Ready when you are", timestamp: 1 }],
    });
    expect(screen.getByText("Ready when you are")).toBeDefined();
    expect(screen.getByText("Fix login")).toBeDefined();

    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    await act(async () => {
      fireEvent.change(prompt, { target: { value: "run the tests" } });
      fireEvent.keyDown(prompt, { key: "Enter" });
    });

    expect(emitted).toContainEqual({
      event: "popout-action",
      payload: { sessionId: "s-1", action: { kind: "send", text: "run the tests" } },
    });
  });

  it("main window answers a popout and performs the actions it forwards", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");
    const sessionId = await startSessionInMainWindow(spy);
    await deliver("acp-event", { sessionId, kind: "turn-end", stopReason: "end_turn" });

    await deliver("popout-ready", { sessionId });
    const snapshot = emitted.find((e) => e.event === "session-snapshot")?.payload as { sessionId: string };
    expect(snapshot.sessionId).toBe(sessionId);

    await deliver("popout-action", { sessionId, action: { kind: "send", text: "hello" } });
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("acp_prompt", expect.objectContaining({ sessionId, text: "hello" }), undefined),
    );
  });

  it("forwards the option picked on an agent's permission request", async () => {
    await act(async () => {
      render(<PopoutApp sessionId="s-1" />);
    });
    await deliver("session-snapshot", {
      sessionId: "s-1",
      session: { ...runningSession, profileId: "qwen-code" },
      messages: [
        {
          id: "m-1",
          role: "agent",
          content: "",
          timestamp: 1,
          actionCard: {
            id: "act-1",
            sessionId: "s-1",
            title: "Permission requested",
            prompt: "Run tests",
            status: "pending",
            timestamp: 1,
            requestId: 3,
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
        },
      ],
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    });

    expect(emitted).toContainEqual({
      event: "popout-action",
      payload: { sessionId: "s-1", action: { kind: "choose-option", cardId: "act-1", optionId: "allow" } },
    });
  });

  it("forwards an answer to an agent's form request", async () => {
    await act(async () => {
      render(<PopoutApp sessionId="s-1" />);
    });
    await deliver("session-snapshot", {
      sessionId: "s-1",
      session: runningSession,
      messages: [
        {
          id: "m-1",
          role: "agent",
          content: "",
          timestamp: 1,
          elicitation: {
            key: "el-1",
            sessionId: "s-1",
            mode: "form",
            message: "What is your name?",
            status: "pending",
            timestamp: 1,
            fields: [{ name: "name", title: "Name", required: true, kind: { type: "text" } }],
          },
        },
      ],
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Ada" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    });

    expect(emitted).toContainEqual({
      event: "popout-action",
      payload: {
        sessionId: "s-1",
        action: { kind: "answer-elicitation", key: "el-1", answer: { action: "accept", content: { name: "Ada" } } },
      },
    });
    // What the user typed goes to the main window only, never to the other popouts.
    expect(sentTo).toContainEqual({ target: "main", event: "popout-action" });
    expect(broadcast).not.toContain("popout-action");
  });

  it("main window answers an agent's request when its popout asks", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");
    const sessionId = await startSessionInMainWindow(spy);
    await deliver("acp-event", {
      sessionId,
      kind: "elicitation",
      key: "el-1",
      request: { mode: "url", message: "Sign in", url: "https://acme.example/login", host: "acme.example" },
    });

    await deliver("popout-action", {
      sessionId,
      action: { kind: "answer-elicitation", key: "el-1", answer: { action: "accept" } },
    });
    await deliver("popout-action", { sessionId, action: { kind: "reopen-elicitation-url", key: "el-1" } });

    expect(spy).toHaveBeenCalledWith(
      "acp_respond_elicitation",
      { sessionId, key: "el-1", action: "accept", content: null },
      undefined,
    );
    expect(spy).toHaveBeenCalledWith("acp_reopen_elicitation_url", { sessionId, key: "el-1" }, undefined);
  });

  it("shows the agent working and stops it from the popout", async () => {
    await act(async () => {
      render(<PopoutApp sessionId="s-1" />);
    });
    await deliver("session-snapshot", {
      sessionId: "s-1",
      session: runningSession,
      messages: [{ id: "u-1", role: "user", content: "refactor it", timestamp: 1 }],
      status: { isBusy: true, isWaiting: false, contextUsage: { used: 300_000, size: 1_000_000 } },
    });

    expect(screen.getByTestId("agent-working")).toBeDefined();
    expect(screen.getByRole("meter", { name: "Context used" }).getAttribute("aria-valuenow")).toBe("30");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    });

    expect(emitted).toContainEqual({ event: "popout-action", payload: { sessionId: "s-1", action: { kind: "stop" } } });
  });

  it("main window stops a session's turn when its popout asks", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");
    const sessionId = await startSessionInMainWindow(spy);

    await deliver("popout-action", { sessionId, action: { kind: "stop" } });

    expect(spy).toHaveBeenCalledWith("acp_cancel", { sessionId }, undefined);
  });
});

