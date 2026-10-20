import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAgentCatalog } from "../hooks/useAgentCatalog";
import { fakeCatalog } from "./fixtures/catalog";

type Listener = (event: { payload: unknown }) => void;

const { listeners, listenFailure } = vi.hoisted(() => ({
  listeners: new Map<string, Listener>(),
  listenFailure: { current: null as string | null },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    if (listenFailure.current) return Promise.reject(new Error(listenFailure.current));
    listeners.set(event, cb);
    return Promise.resolve(() => {
      listeners.delete(event);
    });
  },
}));

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
const internals = () => (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
const catalogCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([cmd]) => cmd === "get_agent_catalog").length;

afterEach(() => {
  vi.restoreAllMocks();
  listeners.clear();
  listenFailure.current = null;
});

describe("useAgentCatalog", () => {
  it("loads the catalog on mount", async () => {
    const { result } = renderHook(() => useAgentCatalog());
    expect(result.current.catalog).toBeNull();
    await waitFor(() => expect(result.current.catalog).not.toBeNull());
    expect(result.current.catalog?.agents).toEqual(fakeCatalog);
    expect(result.current.error).toBeNull();
  });

  it("loads again when the backend reports a change", async () => {
    const spy = vi.spyOn(internals(), "invoke");
    renderHook(() => useAgentCatalog());
    await waitFor(() => expect(catalogCalls(spy)).toBe(1));
    await act(async () => {
      listeners.get("agent-profiles-changed")?.({ payload: null });
    });
    await waitFor(() => expect(catalogCalls(spy)).toBe(2));
  });

  it("reports the message of a failed load", async () => {
    vi.spyOn(internals(), "invoke").mockRejectedValue(new Error("registry unreachable"));
    const { result } = renderHook(() => useAgentCatalog());
    await waitFor(() => expect(result.current.error).toBe("registry unreachable"));
    expect(result.current.catalog).toBeNull();
  });

  it("keeps the newest catalog when an older load resolves last", async () => {
    const stale = { lastChecked: 1, agents: [fakeCatalog[0]] };
    const fresh = { lastChecked: 2, agents: fakeCatalog };
    const resolvers: ((value: unknown) => void)[] = [];
    vi.spyOn(internals(), "invoke").mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const { result } = renderHook(() => useAgentCatalog());
    await waitFor(() => expect(resolvers).toHaveLength(1));
    await act(async () => {
      listeners.get("agent-profiles-changed")?.({ payload: null });
    });
    await waitFor(() => expect(resolvers).toHaveLength(2));

    await act(async () => resolvers[1](fresh));
    await act(async () => resolvers[0](stale));

    expect(result.current.catalog).toEqual(fresh);
  });

  it("keeps the could-not-watch warning after a later successful load", async () => {
    listenFailure.current = "no event bridge";
    const { result } = renderHook(() => useAgentCatalog());
    await waitFor(() => expect(result.current.catalog).not.toBeNull());
    await waitFor(() => expect(result.current.error).toBe("Could not watch for agent changes: no event bridge"));

    await act(async () => result.current.reload());

    expect(result.current.catalog).not.toBeNull();
    expect(result.current.error).toBe("Could not watch for agent changes: no event bridge");
  });
});
