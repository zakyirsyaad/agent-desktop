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

  // 256 is not a multiple of 36: taking byte % 36 would favour "0"–"3". Bytes
  // from 252 up are drawn again, so every character is equally likely.
  it("draws again for bytes that would bias the characters", () => {
    const secure = vi.spyOn(crypto, "getRandomValues");
    secure.mockImplementationOnce((array) => {
      (array as Uint8Array).fill(255);
      return array;
    });

    const id = createId("s");

    expect(secure.mock.calls.length).toBeGreaterThan(1);
    expect(id).toMatch(/^s-\d{13}-[0-9a-z]{5}$/);
  });

  it("gives different ids within the same millisecond", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_792_000_000_000);
    const ids = new Set(Array.from({ length: 100 }, () => createId("s")));
    expect(ids.size).toBe(100);
  });
});
