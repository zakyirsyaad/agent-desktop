import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { open } from "@tauri-apps/plugin-dialog";
import { pickFiles, pickFolder } from "../lib/file-picker";

const mockOpen = open as unknown as Mock;

beforeEach(() => {
  mockOpen.mockReset();
});

describe("pickFolder", () => {
  it("opens the native dialog in single-directory mode", async () => {
    mockOpen.mockResolvedValue("/Users/dev/my-app");

    await pickFolder();

    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][0]).toMatchObject({ directory: true, multiple: false });
  });

  it("derives the display name from the last path segment", async () => {
    mockOpen.mockResolvedValue("/Users/dev/my-app");

    await expect(pickFolder()).resolves.toEqual({
      name: "my-app",
      path: "/Users/dev/my-app",
    });
  });

  it("ignores a trailing separator when naming the folder but returns the path unchanged", async () => {
    mockOpen.mockResolvedValue("/Users/dev/my-app/");

    await expect(pickFolder()).resolves.toEqual({
      name: "my-app",
      path: "/Users/dev/my-app/",
    });
  });

  it("derives the display name from a Windows path", async () => {
    mockOpen.mockResolvedValue("C:\\code\\proj");

    await expect(pickFolder()).resolves.toEqual({
      name: "proj",
      path: "C:\\code\\proj",
    });
  });

  it("resolves null when the user cancels the dialog", async () => {
    mockOpen.mockResolvedValue(null);

    await expect(pickFolder()).resolves.toBeNull();
  });
});

describe("pickFiles", () => {
  it("opens the native dialog in multi-file mode", async () => {
    mockOpen.mockResolvedValue([]);

    await pickFiles();

    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][0]).toMatchObject({ multiple: true, directory: false });
  });

  it("returns every selected path", async () => {
    const selected = ["/Users/dev/my-app/a.ts", "/Users/dev/my-app/b.ts"];
    mockOpen.mockResolvedValue(selected);

    await expect(pickFiles()).resolves.toEqual(selected);
  });

  it("returns an empty list when the user cancels the dialog", async () => {
    mockOpen.mockResolvedValue(null);

    await expect(pickFiles()).resolves.toEqual([]);
  });

  it("wraps a single selected path into a one-element list", async () => {
    mockOpen.mockResolvedValue("/Users/dev/my-app/a.ts");

    await expect(pickFiles()).resolves.toEqual(["/Users/dev/my-app/a.ts"]);
  });
});
