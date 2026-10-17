import { describe, it, expect } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTranscripts } from "../hooks/useTranscripts";
import type { FakeTauriStore } from "./setup";
import type { ChatMessage } from "../types";

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

const saved: ChatMessage = { id: "m-old", role: "user", content: "from disk", timestamp: 1 };
const live: ChatMessage = { id: "m-new", role: "user", content: "typed now", timestamp: 2 };

describe("useTranscripts", () => {
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
