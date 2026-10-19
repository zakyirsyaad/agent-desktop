import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentProfiles } from "../hooks/useDiscovery";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
}));

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
const internals = () => (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;

describe("useAgentProfiles", () => {
  it("detects again when the backend reports that the profiles changed", async () => {
    const spy = vi.spyOn(internals(), "invoke");
    const { unmount } = renderHook(() => useAgentProfiles(() => {}));
    await act(async () => {});
    const before = spy.mock.calls.filter(([cmd]) => cmd === "get_agent_profiles").length;

    await act(async () => {
      listeners.get("agent-profiles-changed")?.({ payload: null });
    });

    const after = spy.mock.calls.filter(([cmd]) => cmd === "get_agent_profiles").length;
    expect(after).toBe(before + 1);
    await act(async () => unmount());
    expect(listeners.has("agent-profiles-changed")).toBe(false);
  });

  afterEach(() => vi.restoreAllMocks());

  it("detects agents with the known PATH on start, and re-reads the login shell's PATH on Check again", async () => {
    const spy = vi.spyOn(internals(), "invoke");
    const { result } = renderHook(() => useAgentProfiles(() => {}));
    await act(async () => {});

    await act(async () => {
      await result.current.refresh();
    });

    const calls = spy.mock.calls.filter(([cmd]) => cmd === "get_agent_profiles").map(([, args]) => args);
    expect(calls[0]).toMatchObject({ refresh: false });
    expect(calls[calls.length - 1]).toMatchObject({ refresh: true });
  });
});
