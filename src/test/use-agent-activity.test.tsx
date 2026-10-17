import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentActivity } from "../hooks/useAgentActivity";
import { AGENT_IDLE_AFTER_MS } from "../lib/activity";

const SESSION_A = "session-a";
const SESSION_B = "session-b";

describe("useAgentActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports an unknown session as idle", () => {
    const { result } = renderHook(() => useAgentActivity());

    expect(result.current.isBusy(SESSION_A)).toBe(false);
    expect(result.current.isBusy("never-seen")).toBe(false);
  });

  it("flips a session to busy as soon as output is marked", () => {
    const { result } = renderHook(() => useAgentActivity());

    act(() => {
      result.current.markOutput(SESSION_A);
    });

    expect(result.current.isBusy(SESSION_A)).toBe(true);
  });

  it("stays busy 1499ms after the last output and goes idle at 1500ms", () => {
    const { result } = renderHook(() => useAgentActivity());

    act(() => {
      result.current.markOutput(SESSION_A);
    });

    act(() => {
      vi.advanceTimersByTime(AGENT_IDLE_AFTER_MS - 1);
    });
    expect(result.current.isBusy(SESSION_A)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.isBusy(SESSION_A)).toBe(false);
  });

  it("extends the busy window when a second chunk arrives at 1000ms", () => {
    const { result } = renderHook(() => useAgentActivity());

    act(() => {
      result.current.markOutput(SESSION_A);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      result.current.markOutput(SESSION_A);
    });

    act(() => {
      vi.advanceTimersByTime(AGENT_IDLE_AFTER_MS - 1);
    });
    expect(result.current.isBusy(SESSION_A)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.isBusy(SESSION_A)).toBe(false);
  });

  it("tracks two sessions independently", () => {
    const { result } = renderHook(() => useAgentActivity());

    act(() => {
      result.current.markOutput(SESSION_A);
    });

    expect(result.current.isBusy(SESSION_A)).toBe(true);
    expect(result.current.isBusy(SESSION_B)).toBe(false);

    act(() => {
      result.current.markOutput(SESSION_B);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      result.current.markOutput(SESSION_A);
    });

    // SESSION_B was last heard from 1000ms ago, SESSION_A just now.
    act(() => {
      vi.advanceTimersByTime(AGENT_IDLE_AFTER_MS - 1000);
    });
    expect(result.current.isBusy(SESSION_A)).toBe(true);
    expect(result.current.isBusy(SESSION_B)).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.isBusy(SESSION_A)).toBe(false);
    expect(result.current.isBusy(SESSION_B)).toBe(false);
  });

  it("honours a custom idle window", () => {
    const { result } = renderHook(() => useAgentActivity(500));

    act(() => {
      result.current.markOutput(SESSION_A);
    });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current.isBusy(SESSION_A)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.isBusy(SESSION_A)).toBe(false);
  });

  it("re-renders once per busy/idle flip, not once per output chunk", () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useAgentActivity();
    });
    const baseline = renderCount;

    act(() => {
      result.current.markOutput(SESSION_A);
      result.current.markOutput(SESSION_A);
      result.current.markOutput(SESSION_A);
    });
    expect(renderCount).toBe(baseline + 1);

    act(() => {
      vi.advanceTimersByTime(AGENT_IDLE_AFTER_MS);
    });
    expect(renderCount).toBe(baseline + 2);
  });

  it("keeps markOutput referentially stable across renders", () => {
    const { result, rerender } = renderHook(() => useAgentActivity());
    const firstMarkOutput = result.current.markOutput;

    act(() => {
      result.current.markOutput(SESSION_A);
    });
    expect(result.current.markOutput).toBe(firstMarkOutput);

    act(() => {
      vi.advanceTimersByTime(AGENT_IDLE_AFTER_MS);
    });
    expect(result.current.markOutput).toBe(firstMarkOutput);

    rerender();
    expect(result.current.markOutput).toBe(firstMarkOutput);
  });

  it("clears every pending idle timer on unmount", () => {
    const { result, unmount } = renderHook(() => useAgentActivity());

    act(() => {
      result.current.markOutput(SESSION_A);
      result.current.markOutput(SESSION_B);
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no pending timer once every session has gone idle", () => {
    const { result } = renderHook(() => useAgentActivity());

    act(() => {
      result.current.markOutput(SESSION_A);
    });
    act(() => {
      vi.advanceTimersByTime(AGENT_IDLE_AFTER_MS);
    });

    expect(result.current.isBusy(SESSION_A)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
