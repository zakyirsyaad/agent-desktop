import { describe, it, expect, vi, afterEach } from "vitest";
import { sweepOrphans } from "../lib/orphan-sweep";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function internals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("orphan sweep", () => {
  it("asks the backend to end what a previous window left running", async () => {
    const spy = vi.spyOn(internals(), "invoke").mockImplementation(() => Promise.resolve(2));

    await expect(sweepOrphans()).resolves.toBeUndefined();

    expect(spy.mock.calls.map(([cmd]) => cmd)).toEqual(["end_orphaned_sessions"]);
  });

  it("fails when the sweep could not be started, so the caller can say so", async () => {
    vi.spyOn(internals(), "invoke").mockImplementation(() => Promise.reject("no backend"));

    await expect(sweepOrphans()).rejects.toBe("no backend");
  });
});
