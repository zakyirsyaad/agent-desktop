import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSessionChanges } from "../hooks/useSessionChanges";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

describe("useSessionChanges", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the newest list when an older read finishes last", async () => {
    const answers: ((value: unknown) => void)[] = [];
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "session_changes" ? new Promise((resolve) => answers.push(resolve)) : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => useSessionChanges("/w/api", true, 0, () => {}));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(answers).toHaveLength(2);

    await act(async () => {
      answers[1]([{ path: "new.ts", oldPath: null, kind: "untracked" }]);
    });
    await act(async () => {
      answers[0]([{ path: "old.ts", oldPath: null, kind: "modified" }]);
    });

    expect(result.current.changes?.map((c) => c.path)).toEqual(["new.ts"]);
  });

  it("counts each list it reads, so open diffs know to read again", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "session_changes" ? Promise.resolve([]) : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => useSessionChanges("/w/api", true, 0, () => {}));
    await waitFor(() => expect(result.current.changes).toEqual([]));
    const first = result.current.version;

    await act(async () => {
      result.current.reload();
    });

    await waitFor(() => expect(result.current.version).toBeGreaterThan(first));
  });
});
