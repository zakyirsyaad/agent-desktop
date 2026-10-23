import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { cachedPreview, loadPreview, MAX_CACHED_PREVIEWS } from "../lib/attachment-previews";

describe("attachment previews", () => {
  it("asks again for a picture that could not be read before", async () => {
    // A screenshot still being written, or a drive not yet mounted, is readable later.
    const calls: string[] = [];
    let fail = true;
    const original = (window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__;
    const realInvoke = original.invoke;
    original.invoke = ((cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== "attachment_preview") return realInvoke(cmd, args);
      calls.push(String(args?.path));
      return fail ? Promise.reject(new Error("not found")) : Promise.resolve("data:image/png;base64,AA==");
    }) as typeof invoke;
    try {
      expect(await loadPreview("/Users/test/later.png")).toBeNull();
      expect(cachedPreview("/Users/test/later.png").found).toBe(false);
      fail = false;
      expect(await loadPreview("/Users/test/later.png")).toBe("data:image/png;base64,AA==");
      expect(calls).toEqual(["/Users/test/later.png", "/Users/test/later.png"]);
    } finally {
      original.invoke = realInvoke;
    }
  });

  it("keeps only the most recent previews", async () => {
    for (let i = 0; i <= MAX_CACHED_PREVIEWS; i += 1) await loadPreview(`/Users/test/shot-${i}.png`);

    expect(cachedPreview("/Users/test/shot-0.png").found).toBe(false);
    expect(cachedPreview(`/Users/test/shot-${MAX_CACHED_PREVIEWS}.png`).found).toBe(true);
  });
});
