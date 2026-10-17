import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import type { FakeTauriStore } from "./setup";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener[]>();
const emitted: { event: string; payload: unknown }[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    return Promise.resolve(() => {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== cb));
    });
  },
  emit: (event: string, payload: unknown) => {
    emitted.push({ event, payload });
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

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

async function deliver(event: string, payload: unknown) {
  await act(async () => {
    (listeners.get(event) ?? []).forEach((cb) => cb({ payload }));
  });
}

const runningSession = {
  id: "s-1",
  name: "Fix login",
  profileId: "claude-code",
  cwd: "/Users/test/developer/agent-desktop",
  status: "running",
  createdAt: 1,
};

describe("Popout windows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
    emitted.length = 0;
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
    fakeStore().state.sessions = [runningSession];
    const spy = vi.spyOn(tauriInternals(), "invoke");
    await act(async () => {
      render(<App />);
    });

    await deliver("popout-ready", { sessionId: "s-1" });
    const snapshot = emitted.find((e) => e.event === "session-snapshot")?.payload as { sessionId: string };
    expect(snapshot.sessionId).toBe("s-1");

    await deliver("popout-action", { sessionId: "s-1", action: { kind: "send", text: "hello" } });
    expect(spy).toHaveBeenCalledWith("send_input", { sessionId: "s-1", data: "hello\n" }, undefined);
  });

  it("forwards the option picked on an agent's permission request", async () => {
    await act(async () => {
      render(<PopoutApp sessionId="s-1" />);
    });
    await deliver("session-snapshot", {
      sessionId: "s-1",
      session: { ...runningSession, profileId: "qwen", transport: "acp" },
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
            approvalKey: "",
            rejectKey: "",
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
    fakeStore().state.sessions = [runningSession];
    const spy = vi.spyOn(tauriInternals(), "invoke");
    await act(async () => {
      render(<App />);
    });

    await deliver("popout-action", { sessionId: "s-1", action: { kind: "stop" } });

    expect(spy).toHaveBeenCalledWith("send_input", { sessionId: "s-1", data: "\x03" }, undefined);
  });
});

