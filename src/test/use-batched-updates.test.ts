import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBatchedUpdates } from "../hooks/useBatchedUpdates";
import type { ChatMessage } from "../types";

function message(id: string): ChatMessage {
  return { id, role: "agent", content: id, timestamp: 1 };
}

const closeTurn = (prev: ChatMessage[]) =>
  prev.map((current, index) => (index === prev.length - 1 ? { ...current, isComplete: true } : current));

describe("useBatchedUpdates", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("applies updates queued in one frame once, in order", async () => {
    const updateMessages = vi.fn();
    const { result } = renderHook(() => useBatchedUpdates(updateMessages));

    act(() => {
      result.current.update("s-1", (prev) => [...prev, message("a")]);
      result.current.update("s-1", (prev) => [...prev, message("b")]);
      result.current.update("s-1", (prev) => [...prev, message("c")]);
    });
    expect(updateMessages).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });

    expect(updateMessages).toHaveBeenCalledTimes(1);
    const [, apply] = updateMessages.mock.calls[0];
    expect(apply([]).map((m: ChatMessage) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("applies a turn end after the updates queued before it", async () => {
    const updateMessages = vi.fn();
    const { result } = renderHook(() => useBatchedUpdates(updateMessages));

    act(() => {
      result.current.update("s-1", (prev) => [...prev, message("a")]);
      result.current.update("s-1", (prev) => [...prev, message("b")]);
      result.current.update("s-1", closeTurn);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });

    expect(updateMessages).toHaveBeenCalledTimes(1);
    const [, apply] = updateMessages.mock.calls[0];
    const applied = apply([]);
    expect(applied.map((m: ChatMessage) => m.id)).toEqual(["a", "b"]);
    expect(applied[1].isComplete).toBe(true);
  });

  it("flushes queued updates at once, before a read", () => {
    const updateMessages = vi.fn();
    const { result } = renderHook(() => useBatchedUpdates(updateMessages));

    act(() => {
      result.current.update("s-1", (prev) => [...prev, message("a")]);
      result.current.flush();
    });

    expect(updateMessages).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(updateMessages).toHaveBeenCalledTimes(1);
  });

  it("keeps each session's updates in their own call and order", async () => {
    const updateMessages = vi.fn();
    const { result } = renderHook(() => useBatchedUpdates(updateMessages));

    act(() => {
      result.current.update("s-1", (prev) => [...prev, message("a")]);
      result.current.update("s-2", (prev) => [...prev, message("b")]);
      result.current.update("s-1", (prev) => [...prev, message("c")]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });

    expect(updateMessages).toHaveBeenCalledTimes(2);
    const applied = Object.fromEntries(
      updateMessages.mock.calls.map(([sessionId, apply]) => [sessionId, apply([]).map((m: ChatMessage) => m.id)]),
    );
    expect(applied).toEqual({ "s-1": ["a", "c"], "s-2": ["b"] });
  });

  it("drops a removed session's queued updates", async () => {
    const updateMessages = vi.fn();
    const { result } = renderHook(() => useBatchedUpdates(updateMessages));

    act(() => {
      result.current.update("s-1", (prev) => [...prev, message("gone")]);
      result.current.update("s-2", (prev) => [...prev, message("kept")]);
      result.current.forget("s-1");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });

    expect(updateMessages).toHaveBeenCalledTimes(1);
    const [sessionId, apply] = updateMessages.mock.calls[0];
    expect(sessionId).toBe("s-2");
    expect(apply([]).map((m: ChatMessage) => m.id)).toEqual(["kept"]);
  });

  it("flushes from a timer when animation frames never fire, as in a hidden window", async () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const updateMessages = vi.fn();
    const { result } = renderHook(() => useBatchedUpdates(updateMessages));

    act(() => {
      result.current.update("s-1", (prev) => [...prev, message("a")]);
    });
    expect(updateMessages).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(updateMessages).toHaveBeenCalledTimes(1);
    const [, apply] = updateMessages.mock.calls[0];
    expect(apply([]).map((m: ChatMessage) => m.id)).toEqual(["a"]);

    frame.mockRestore();
  });

  it("does not flush again when the frame fires before the fallback timer", async () => {
    const updateMessages = vi.fn();
    const { result } = renderHook(() => useBatchedUpdates(updateMessages));

    act(() => {
      result.current.update("s-1", (prev) => [...prev, message("a")]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(updateMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(updateMessages).toHaveBeenCalledTimes(1);
  });
});
