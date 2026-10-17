import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentProfiles } from "../hooks/useDiscovery";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
const internals = () => (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;

describe("useAgentProfiles", () => {
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
