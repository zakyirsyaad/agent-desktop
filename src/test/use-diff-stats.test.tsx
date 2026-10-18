import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useDiffStats, useDiffTargets } from "../hooks/useDiffStats";
import type { FileStat } from "../lib/diff-stats";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

const STAT: FileStat = { path: "a.ts", oldPath: null, kind: "modified", added: 1, removed: 0, isBinary: false };

function statCalls(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter((call) => call[0] === "session_diff_stats");
}

describe("useDiffStats", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the stats against the target", async () => {
    const spy = vi
      .spyOn(tauriInternals(), "invoke")
      .mockImplementation((cmd) => Promise.resolve(cmd === "session_diff_stats" ? [STAT] : undefined));
    const { result } = renderHook(() => useDiffStats("/w", true, "head", 1, () => {}));

    await waitFor(() => expect(result.current.stats).toEqual([STAT]));
    expect(spy).toHaveBeenCalledWith("session_diff_stats", { path: "/w", target: "head" }, undefined);
  });

  it("reads again when the version or the target changes", async () => {
    const spy = vi
      .spyOn(tauriInternals(), "invoke")
      .mockImplementation((cmd) => Promise.resolve(cmd === "session_diff_stats" ? [STAT] : undefined));
    const { result, rerender } = renderHook(
      ({ target, version }) => useDiffStats("/w", true, target, version, () => {}),
      { initialProps: { target: "head" as "head" | "base", version: 1 } },
    );
    await waitFor(() => expect(result.current.stats).not.toBeNull());
    expect(statCalls(spy)).toHaveLength(1);

    rerender({ target: "head", version: 2 });
    await waitFor(() => expect(statCalls(spy)).toHaveLength(2));
    rerender({ target: "base", version: 2 });
    await waitFor(() => expect(statCalls(spy)).toHaveLength(3));
    expect(statCalls(spy)[2][1]).toEqual({ path: "/w", target: "base" });
  });

  it("reports a failed read once per folder, naming it", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockRejectedValue("boom");
    const onError = vi.fn();
    const { rerender } = renderHook(({ version }) => useDiffStats("/w", true, "head", version, onError), {
      initialProps: { version: 1 },
    });
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][0]).toContain("/w");

    rerender({ version: 2 });
    await act(async () => {});
    expect(onError).toHaveBeenCalledOnce();
  });

  it("reads nothing outside a repository", () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");
    const { result } = renderHook(() => useDiffStats("/w", false, "head", 1, () => {}));

    expect(result.current.stats).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("useDiffTargets", () => {
  afterEach(() => vi.restoreAllMocks());

  it("has no base until read", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockResolvedValue({ base: { name: "main" } });
    const { result } = renderHook(() => useDiffTargets("/w", true, 1));

    expect(result.current).toEqual({ base: null });
    await waitFor(() => expect(result.current).toEqual({ base: { name: "main" } }));
  });
});
