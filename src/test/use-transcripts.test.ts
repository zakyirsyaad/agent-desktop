import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
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
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("will not be saved over it"));
    expect(spy.mock.calls.some(([cmd]) => cmd === "save_transcript")).toBe(false);
  });

  it("keeps the saved history when a message arrives before the transcript has loaded", async () => {
    fakeStore().transcripts["s-1"] = [saved];
    const { result } = renderHook(() => useTranscripts(() => {}));

    act(() => {
      result.current.ensureLoaded("s-1");
      result.current.updateMessages("s-1", (prev) => [...prev, live]);
    });

    await waitFor(() => expect(result.current.transcripts["s-1"]?.map((m) => m.id)).toEqual(["m-old", "m-new"]));
    await waitFor(() => expect((fakeStore().transcripts["s-1"] as ChatMessage[]).map((m) => m.id)).toEqual(["m-old", "m-new"]));
  });
});
