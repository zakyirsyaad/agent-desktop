import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppFonts } from "../lib/fonts";

const setFonts = (fonts: unknown) =>
  Object.defineProperty(document, "fonts", { value: fonts, configurable: true });

describe("loadAppFonts", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete (document as { fonts?: unknown }).fonts;
  });

  it("resolves at once when document.fonts is missing", async () => {
    setFonts(undefined);
    await expect(loadAppFonts(1000)).resolves.toBeUndefined();
  });

  it("loads both families", async () => {
    const load = vi.fn().mockResolvedValue([]);
    setFonts({ load });
    await loadAppFonts(1000);
    expect(load).toHaveBeenCalledWith('400 14px "Instrument Sans Variable"');
    expect(load).toHaveBeenCalledWith('400 12px "Geist Mono Variable"');
  });

  it("resolves when a font fails to load", async () => {
    setFonts({ load: vi.fn().mockRejectedValue(new Error("x")) });
    await expect(loadAppFonts(1000)).resolves.toBeUndefined();
  });

  it("resolves after the timeout when loading hangs", async () => {
    vi.useFakeTimers();
    setFonts({ load: () => new Promise(() => {}) });
    const done = loadAppFonts(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toBeUndefined();
  });
});
