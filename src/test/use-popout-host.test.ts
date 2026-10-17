import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ChatMessage, Session } from "../types";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();
const emitted: { event: string; payload: unknown }[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
  emit: (event: string, payload: unknown) => {
    emitted.push({ event, payload });
    return Promise.resolve();
  },
}));

import { usePopoutHost } from "../hooks/usePopoutHost";

const session = (id: string): Session => ({ id, name: id, profileId: "qwen", cwd: "/w", status: "running", createdAt: 1 });
const message = (id: string): ChatMessage => ({ id, role: "agent", content: id, timestamp: 1 });
const snapshotsFor = (sessionId: string) =>
  emitted.filter((e) => e.event === "session-snapshot" && (e.payload as { sessionId: string }).sessionId === sessionId);

describe("usePopoutHost", () => {
  beforeEach(() => {
    emitted.length = 0;
    listeners.clear();
  });

  it("re-sends a popout's snapshot only when its own session changes, and stops once it closes", async () => {
    const sessions = [session("s-1"), session("s-2")];
    const props = {
      sessions,
      transcripts: { "s-1": [message("a")], "s-2": [message("b")] } as Record<string, ChatMessage[]>,
      ensureLoaded: () => {},
      onAction: () => {},
    };
    const { rerender } = renderHook((p: typeof props) => usePopoutHost(p), { initialProps: props });
    await act(async () => {});
    act(() => listeners.get("popout-ready")?.({ payload: { sessionId: "s-1" } }));
    const afterReady = snapshotsFor("s-1").length;

    // Another session streams: s-1's popout gets nothing new.
    rerender({ ...props, transcripts: { ...props.transcripts, "s-2": [message("b"), message("c")] } });
    expect(snapshotsFor("s-1")).toHaveLength(afterReady);

    // Its own session changes: one new snapshot.
    const changed = { ...props.transcripts, "s-1": [message("a"), message("d")] };
    rerender({ ...props, transcripts: changed });
    expect(snapshotsFor("s-1")).toHaveLength(afterReady + 1);

    // Closed: no more snapshots.
    act(() => listeners.get("popout-closed")?.({ payload: { sessionId: "s-1" } }));
    rerender({ ...props, transcripts: { ...changed, "s-1": [message("e")] } });
    expect(snapshotsFor("s-1")).toHaveLength(afterReady + 1);
  });

  it("re-sends a popout's snapshot when its agent starts or stops working", async () => {
    let busy = false;
    const props = {
      sessions: [session("s-1")],
      transcripts: { "s-1": [message("a")] } as Record<string, ChatMessage[]>,
      ensureLoaded: () => {},
      onAction: () => {},
      statusOf: () => ({ isBusy: busy, isWaiting: false }),
    };
    const { rerender } = renderHook((p: typeof props) => usePopoutHost(p), { initialProps: props });
    await act(async () => {});
    act(() => listeners.get("popout-ready")?.({ payload: { sessionId: "s-1" } }));
    const before = snapshotsFor("s-1").length;

    busy = true;
    rerender({ ...props });

    expect(snapshotsFor("s-1")).toHaveLength(before + 1);
    expect((snapshotsFor("s-1").at(-1)?.payload as { status: { isBusy: boolean } }).status.isBusy).toBe(true);
  });
});

