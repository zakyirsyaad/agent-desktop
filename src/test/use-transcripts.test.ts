import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTranscripts } from "../hooks/useTranscripts";
import type { FakeTauriStore } from "./setup";
import type { ChatMessage } from "../types";

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

const saved: ChatMessage = { id: "m-old", role: "user", content: "from disk", timestamp: 1 };
const live: ChatMessage = { id: "m-new", role: "user", content: "typed now", timestamp: 2 };

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

describe("useTranscripts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never saves over a transcript it could not read", async () => {
    const real = tauriInternals().invoke;
    const spy = vi
      .spyOn(tauriInternals(), "invoke")
      .mockImplementation((cmd, args) => (cmd === "load_transcript" ? Promise.reject("bad JSON") : real(cmd, args)));
    const onError = vi.fn();
    const { result } = renderHook(() => useTranscripts(onError));

    await act(async () => {
      result.current.ensureLoaded("s-1");
    });
    act(() => result.current.updateMessages("s-1", (prev) => [...prev, live]));
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("will not be saved over it"));
    expect(spy.mock.calls.some(([cmd]) => cmd === "save_transcript")).toBe(false);
  });

  it("keeps the saved history when a message arrives before the transcript has loaded", async () => {
    // The save is throttled to once a second; fake time makes the test wait for it
    // exactly, not race a real second against waitFor's own one-second limit.
    vi.useFakeTimers();
    try {
      fakeStore().transcripts["s-1"] = [saved];
      const { result } = renderHook(() => useTranscripts(() => {}));

      act(() => {
        result.current.ensureLoaded("s-1");
        result.current.updateMessages("s-1", (prev) => [...prev, live]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.transcripts["s-1"]?.map((m) => m.id)).toEqual(["m-old", "m-new"]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect((fakeStore().transcripts["s-1"] as ChatMessage[]).map((m) => m.id)).toEqual(["m-old", "m-new"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves a streaming transcript at most once a second, without waiting for the stream to stop", async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(tauriInternals(), "invoke");
      const { result } = renderHook(() => useTranscripts(() => {}));
      const saves = () => spy.mock.calls.filter(([cmd]) => cmd === "save_transcript").length;

      // A chunk every 100ms for 2.5s, as an agent streams.
      for (let i = 0; i < 25; i++) {
        act(() => result.current.updateMessages("s-1", (prev) => [...prev, { ...live, id: `m-${i}` }]));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
      }

      expect(saves()).toBeGreaterThanOrEqual(2);
      expect(saves()).toBeLessThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes a pending transcript right away when the window goes away", () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");
    const { result } = renderHook(() => useTranscripts(() => {}));

    act(() => result.current.updateMessages("s-1", (prev) => [...prev, live]));
    window.dispatchEvent(new Event("pagehide"));

    expect(spy.mock.calls.some(([cmd]) => cmd === "save_transcript")).toBe(true);
  });
});

