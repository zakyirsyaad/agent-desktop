import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentProfiles } from "../hooks/useDiscovery";

type Listener = (event: { payload: unknown }) => void;
type Listen = (event: string, cb: Listener) => Promise<() => void>;

const { listeners, mockListen } = vi.hoisted(() => {
  const listeners = new Map<string, Listener>();
  const registerAtOnce: Listen = (event, cb) => {
    listeners.set(event, cb);
    return Promise.resolve(() => {
      listeners.delete(event);
    });
  };
  return { listeners, mockListen: { impl: registerAtOnce, registerAtOnce } };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => mockListen.impl(event, cb),
}));

/** Collects the unhandled promise rejections that happen while `run` and a few ticks after it run. */
async function unhandledRejectionsDuring(run: () => Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const record = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", record);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", record);
  }
  return rejections;
}

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

  afterEach(() => {
    vi.restoreAllMocks();
    mockListen.impl = mockListen.registerAtOnce;
    listeners.clear();
  });

  it("stops listening and detects nothing more when unmounted before the listener is ready", async () => {
    let ready: (stop: () => void) => void = () => {};
    const stop = vi.fn();
    mockListen.impl = (event, cb) => {
      listeners.set(event, cb);
      return new Promise((resolve) => {
        ready = resolve;
      });
    };
    const spy = vi.spyOn(internals(), "invoke");
    const { unmount } = renderHook(() => useAgentProfiles(() => {}));
    await act(async () => {});
    const before = spy.mock.calls.filter(([cmd]) => cmd === "get_agent_profiles").length;

    const rejections = await unhandledRejectionsDuring(async () => {
      await act(async () => unmount());
      listeners.get("agent-profiles-changed")?.({ payload: null });
      await act(async () => ready(stop));
    });

    expect(spy.mock.calls.filter(([cmd]) => cmd === "get_agent_profiles").length).toBe(before);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(rejections).toEqual([]);
  });

  it("reports a listener that could not be set up, without an unhandled rejection", async () => {
    mockListen.impl = () => Promise.reject(new Error("no event bridge"));
    const onError = vi.fn();

    const rejections = await unhandledRejectionsDuring(async () => {
      const { unmount } = renderHook(() => useAgentProfiles(onError));
      await act(async () => {});
      await act(async () => unmount());
    });

    expect(rejections).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("no event bridge"));
  });

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
