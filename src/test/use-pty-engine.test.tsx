import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
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

function callsTo(spy: { mock: { calls: unknown[][] } }, cmd: string) {
  return spy.mock.calls.filter((call) => call[0] === cmd).map((call) => call[1]);
}

describe("usePtyEngine", () => {
  afterEach(() => vi.restoreAllMocks());

  // A TUI reads text and Enter arriving in one write as a paste, and keeps the
  // Enter inside its prompt instead of submitting.
  it("types a message, then presses Enter on its own", async () => {
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
});
