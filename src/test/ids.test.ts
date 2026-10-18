import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "../lib/ids";

describe("createId", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the readable shape: prefix, time, five base-36 characters", () => {
    expect(createId("s")).toMatch(/^s-\d{13}-[0-9a-z]{5}$/);
  });

  // Session ids reach the backend that runs the agent, so they come from the
  // platform's secure generator, never Math.random.
  it("draws its random part from crypto.getRandomValues", () => {
    const secure = vi.spyOn(crypto, "getRandomValues");
    const insecure = vi.spyOn(Math, "random");

    createId("s");

    expect(secure).toHaveBeenCalled();
    expect(insecure).not.toHaveBeenCalled();
  });

  it("gives different ids within the same millisecond", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_792_000_000_000);
    const ids = new Set(Array.from({ length: 100 }, () => createId("s")));
    expect(ids.size).toBe(100);
  });
});
