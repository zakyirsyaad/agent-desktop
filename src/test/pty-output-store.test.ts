import { describe, it, expect, vi } from "vitest";
import { createPtyOutputStore } from "../lib/pty-output-store";

describe("PTY output store", () => {
  it("keeps a session's output so a terminal opened later can replay it", () => {
    const store = createPtyOutputStore();
    store.append("s-1", "hello ");
    store.append("s-2", "other");
    store.append("s-1", "world");

    expect(store.snapshot("s-1")).toBe("hello world");
    expect(store.has("s-1")).toBe(true);
    expect(store.has("s-3")).toBe(false);
  });

  it("delivers new output to subscribers of that session until they unsubscribe", () => {
    const store = createPtyOutputStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe("s-1", listener);

    store.append("s-1", "a");
    store.append("s-2", "b");
    unsubscribe();
    store.append("s-1", "c");

    expect(listener.mock.calls).toEqual([["a"]]);
  });

  it("drops whole old chunks beyond the size limit, never cutting one in the middle", () => {
    const store = createPtyOutputStore({ maxChars: 10 });
    store.append("s-1", "0123");
    store.append("s-1", "4567");
    store.append("s-1", "89ab");

    expect(store.snapshot("s-1")).toBe("456789ab");
  });

  it("keeps the end of a single chunk larger than the limit", () => {
    const store = createPtyOutputStore({ maxChars: 4 });
    store.append("s-1", "abcdefgh");

    expect(store.snapshot("s-1")).toBe("efgh");
  });

  it("forgets a deleted session's output", () => {
    const store = createPtyOutputStore();
    store.append("s-1", "x");
    store.forget("s-1");

    expect(store.snapshot("s-1")).toBe("");
  });
});
