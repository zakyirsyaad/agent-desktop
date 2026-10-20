import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePersistedState } from "../hooks/usePersistedState";
import { fakeTauriInvoke, type FakeTauriStore } from "./setup";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

const base = { name: "Session", profileId: "claude-acp", cwd: "/w", status: "terminated", createdAt: 1 };

function seedSessions(sessions: Record<string, unknown>[]) {
  fakeStore().state.sessions = sessions.map((s) => ({ ...base, name: String(s.id), ...s }));
}

function savedSessionIds(): string[] {
  return (fakeStore().state.sessions as { id: string }[]).map((s) => s.id);
}

afterEach(() => vi.restoreAllMocks());

describe("usePersistedState - terminal sessions", () => {
  const mixed = [{ id: "a", transport: "acp" }, { id: "p", transport: "pty" }, { id: "old" }];

  it("deletes the transcripts of dropped terminal sessions and saves the cleaned state", async () => {
    seedSessions(mixed);
    const spy = vi.spyOn(tauriInternals(), "invoke");
    const onError = vi.fn();

    const { result } = renderHook(() => usePersistedState(onError));
    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    expect(result.current.state.sessions.map((s) => s.id)).toEqual(["a"]);
    expect(spy).toHaveBeenCalledWith("delete_transcript", { sessionId: "p" }, undefined);
    expect(spy).toHaveBeenCalledWith("delete_transcript", { sessionId: "old" }, undefined);
    await waitFor(() => expect(savedSessionIds()).toEqual(["a"]));
    expect(onError).not.toHaveBeenCalled();
  });

  it("still loads when a transcript cannot be deleted", async () => {
    seedSessions(mixed);
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "delete_transcript" && args?.sessionId === "p"
        ? Promise.reject("disk full")
        : fakeTauriInvoke(cmd, args),
    );
    const onError = vi.fn();

    const { result } = renderHook(() => usePersistedState(onError));
    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    expect(result.current.state.sessions.map((s) => s.id)).toEqual(["a"]);
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toContain("disk full");
  });

  it("loads a file whose sessions are all terminal sessions as an empty list", async () => {
    seedSessions([{ id: "p", transport: "pty" }]);
    const onError = vi.fn();

    const { result } = renderHook(() => usePersistedState(onError));
    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    expect(result.current.state.sessions).toEqual([]);
    await waitFor(() => expect(savedSessionIds()).toEqual([]));
  });
});
