import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(),
}));

import { getVersion } from "@tauri-apps/api/app";
import { getAppVersion } from "../lib/app-info";

const mockedGetVersion = vi.mocked(getVersion);

describe("getAppVersion", () => {
  beforeEach(() => {
    mockedGetVersion.mockReset();
  });

  it("returns the bundled app version", async () => {
    mockedGetVersion.mockResolvedValue("0.1.0");

    await expect(getAppVersion()).resolves.toBe("0.1.0");
    expect(mockedGetVersion).toHaveBeenCalledTimes(1);
  });

  it("resolves to null outside the Tauri webview instead of rejecting", async () => {
    mockedGetVersion.mockRejectedValue(
      new Error("window.__TAURI_INTERNALS__ is undefined")
    );

    await expect(getAppVersion()).resolves.toBeNull();
  });
});
