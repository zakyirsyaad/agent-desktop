import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
  emit: () => Promise.resolve(),
}));

import { usePtyEngine } from "../hooks/session-engine/usePtyEngine";
import { createPtyOutputStore } from "../lib/pty-output-store";
import type { Session } from "../types";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

const SESSION = { id: "s-1", cwd: "/w", profileId: "omp", status: "running" } as Session;

function renderEngine(reportError = vi.fn()) {
  return renderHook(() =>
    usePtyEngine({
      sessions: [SESSION],
      agents: [],
      updateMessages: () => {},
      patchSession: () => {},
      reportError,
      output: createPtyOutputStore(),
    }),
  );
}

async function agentPrints(data: string) {
  await waitFor(() => expect(listeners.has("pty-output")).toBe(true));
  await act(async () => listeners.get("pty-output")?.({ payload: { session_id: "s-1", data } }));
}

async function agentExits() {
  await waitFor(() => expect(listeners.has("pty-exit")).toBe(true));
  await act(async () => listeners.get("pty-exit")?.({ payload: { session_id: "s-1", exit_code: 0 } }));
}

function callsTo(spy: { mock: { calls: unknown[][] } }, cmd: string) {
  return spy.mock.calls.filter((call) => call[0] === cmd).map((call) => call[1]);
}

describe("usePtyEngine", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
  });

  // A TUI reads text and Enter arriving in one read as a paste, and keeps the
  // Enter inside its prompt instead of submitting.
  it("types a message, then presses Enter on its own, for an agent without paste mode", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockResolvedValue(undefined);
    const { result } = renderEngine();

    await act(async () => {
      await result.current.send("s-1", "run the tests");
    });

    expect(callsTo(spy, "send_input")).toEqual([
      { sessionId: "s-1", data: "run the tests" },
      { sessionId: "s-1", data: "\r" },
    ]);
  });

  // Oh-My-Pi turns paste mode on; a bracketed message submits however the
  // agent's reads split it, even while it is busy starting up.
  it("sends a bracketed message and its Enter in one write once the agent turned paste mode on", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockResolvedValue(undefined);
    const { result } = renderEngine();
    await agentPrints("omp v18\x1b[?2004h❯ ");

    await act(async () => {
      await result.current.send("s-1", "run the tests");
    });

    expect(callsTo(spy, "send_input")).toEqual([{ sessionId: "s-1", data: "\x1b[200~run the tests\x1b[201~\r" }]);
  });

  it("never interleaves two messages sent at once", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockResolvedValue(undefined);
    const { result } = renderEngine();

    await act(async () => {
      await Promise.all([result.current.send("s-1", "first"), result.current.send("s-1", "second")]);
    });

    expect(callsTo(spy, "send_input").map((args) => (args as { data: string }).data)).toEqual([
      "first",
      "\r",
      "second",
      "\r",
    ]);
  });

  // The terminal view measures itself as soon as it shows, before the agent's
  // process exists; that size must reach the agent once it does.
  it("holds a resize until the session has started, then applies the latest size", async () => {
    let finishSpawn: () => void = () => {};
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "spawn_session" ? new Promise<void>((resolve) => (finishSpawn = resolve)) : Promise.resolve(),
    );
    const reportError = vi.fn();
    const { result } = renderEngine(reportError);

    act(() => {
      result.current.start(SESSION, {} as never);
      result.current.resize("s-1", 60, 20);
      result.current.resize("s-1", 120, 30);
    });
    expect(callsTo(spy, "resize_session")).toEqual([]);

    await act(async () => finishSpawn());
    await waitFor(() => expect(callsTo(spy, "resize_session")).toEqual([{ sessionId: "s-1", cols: 120, rows: 30 }]));
    expect(reportError).not.toHaveBeenCalled();
  });

  it("resizes a started session right away", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockResolvedValue(undefined);
    const { result } = renderEngine();

    await act(async () => result.current.start(SESSION, {} as never));
    act(() => result.current.resize("s-1", 100, 40));

    await waitFor(() => expect(callsTo(spy, "resize_session")).toEqual([{ sessionId: "s-1", cols: 100, rows: 40 }]));
  });

  it("stops resizing a session once its agent has exited", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockResolvedValue(undefined);
    const { result } = renderEngine();
    await act(async () => result.current.start(SESSION, {} as never));

    await agentExits();
    act(() => result.current.resize("s-1", 100, 40));

    expect(callsTo(spy, "resize_session")).toEqual([]);
  });
});
