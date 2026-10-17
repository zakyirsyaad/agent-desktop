import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useWorkspaceDetails } from "../hooks/useWorkspaceDetails";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

describe("useWorkspaceDetails", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads a folder's location and branch, and again when the window regains focus", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");
    const { result } = renderHook(() => useWorkspaceDetails("/w/api", () => {}));

    await waitFor(() => expect(result.current).toEqual({ location: "~/developer", branch: "main" }));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(spy.mock.calls.filter(([cmd]) => cmd === "workspace_details")).toHaveLength(2);
  });

  it("reports a failure once per folder, however often the window regains focus", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "workspace_details" ? Promise.reject("/w/gone is not accessible") : Promise.resolve(undefined),
    );
    const onError = vi.fn();
    const { result } = renderHook(() => useWorkspaceDetails("/w/gone", onError));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain("/w/gone is not accessible");
    expect(result.current).toBeNull();
  });
});
