import { describe, it, expect } from "vitest";
import type { invoke } from "@tauri-apps/api/core";
import { cachedPreview, loadPreview } from "../lib/attachment-previews";

type Internals = { invoke: typeof invoke };

/** Routes `attachment_preview` to `answer` and records each path asked for. */
function withPreviewBackend(answer: () => Promise<void>): { calls: string[]; restore: () => void } {
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
  const realInvoke = internals.invoke;
  const calls: string[] = [];
  internals.invoke = ((cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== "attachment_preview") return realInvoke(cmd, args);
    calls.push(String(args?.path));
    return answer();
  }) as typeof invoke;
  return { calls, restore: () => (internals.invoke = realInvoke) };
}

describe("attachment previews", () => {
  it("serves an allowed picture through the asset protocol", async () => {
    const src = await loadPreview("/Users/test/shot one.png");

    expect(src).toBe("asset://localhost/%2FUsers%2Ftest%2Fshot%20one.png");
    expect(cachedPreview("/Users/test/shot one.png")).toBe(src);
  });

  it("asks again for a picture that could not be read before", async () => {
    // A screenshot still being written, or a drive not yet mounted, is readable later.
    let fail = true;
    const backend = withPreviewBackend(() => (fail ? Promise.reject(new Error("not found")) : Promise.resolve()));
    try {
      expect(await loadPreview("/Users/test/later.png")).toBeNull();
      expect(cachedPreview("/Users/test/later.png")).toBeUndefined();
      fail = false;
      expect(await loadPreview("/Users/test/later.png")).not.toBeNull();
      expect(backend.calls).toEqual(["/Users/test/later.png", "/Users/test/later.png"]);
    } finally {
      backend.restore();
    }
  });

  it("shares one backend call between thumbnails that load at once", async () => {
    // The sent bubble, the composer chip and the dialog can all mount together.
    const backend = withPreviewBackend(() => Promise.resolve());
    try {
      const [a, b, c] = await Promise.all([
        loadPreview("/Users/test/once.png"),
        loadPreview("/Users/test/once.png"),
        loadPreview("/Users/test/once.png"),
      ]);

      expect(backend.calls).toEqual(["/Users/test/once.png"]);
      expect(new Set([a, b, c]).size).toBe(1);
    } finally {
      backend.restore();
    }
  });
});
