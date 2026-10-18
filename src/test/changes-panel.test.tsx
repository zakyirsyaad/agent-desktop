import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { ChangesPanel } from "../components/changes/ChangesPanel";
import type { FileChange } from "../lib/git-changes";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

const CHANGES: FileChange[] = [
  { path: "src/app.ts", oldPath: null, kind: "modified" },
  { path: "new.md", oldPath: "old.md", kind: "renamed" },
  { path: "notes.md", oldPath: null, kind: "untracked" },
];

function renderPanel(overrides: Partial<Parameters<typeof ChangesPanel>[0]> = {}) {
  const props = {
    rootPath: "/w/api",
    rootName: "api",
    branch: "agent/fix",
    changes: CHANGES,
    version: 1,
    onReload: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<ChangesPanel {...props} />);
  return props;
}

describe("ChangesPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists each changed file with its kind, and the folder and branch", () => {
    renderPanel();

    const list = within(screen.getByRole("list", { name: "Changes in api" }));
    expect(list.getAllByRole("listitem")).toHaveLength(3);
    expect(list.getByLabelText("Renamed")).toBeDefined();
    expect(list.getByTitle("old.md → new.md")).toBeDefined();
    expect(screen.getByText("agent/fix")).toBeDefined();
    expect(screen.getByRole("button", { name: "Commit 3 files" })).toBeDefined();
  });

  it("shows a file's diff when it is opened", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "session_file_diff"
        ? Promise.resolve("diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-two\n+2\n")
        : Promise.resolve(undefined),
    );
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByTitle("src/app.ts"));
    });

    expect(spy).toHaveBeenCalledWith(
      "session_file_diff",
      { path: "/w/api", file: "src/app.ts", target: "head" },
      undefined,
    );
    const diff = within(screen.getByLabelText("Diff of src/app.ts"));
    expect(diff.getByText("two").closest("[data-line]")?.getAttribute("data-line")).toBe("removed");
    expect(diff.getByText("2").closest("[data-line]")?.getAttribute("data-line")).toBe("added");
  });

  it("reads an open diff again when the list is read again", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "session_file_diff" ? Promise.resolve("@@ -1 +1 @@\n-a\n+b\n") : Promise.resolve(undefined),
    );
    const props = {
      rootPath: "/w/api",
      rootName: "api",
      changes: CHANGES,
      version: 1,
      onReload: () => {},
      onClose: () => {},
    };
    const { rerender } = render(<ChangesPanel {...props} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle("src/app.ts"));
    });
    const reads = () => spy.mock.calls.filter(([cmd]) => cmd === "session_file_diff").length;
    expect(reads()).toBe(1);

    await act(async () => {
      rerender(<ChangesPanel {...props} changes={[...CHANGES]} version={2} />);
    });

    expect(reads()).toBe(2);
  });

  it("commits only the chosen files, with a rename's old path, and reloads", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "commit_session_changes" ? Promise.resolve("abc1234") : Promise.resolve(undefined),
    );
    const props = renderPanel();
    const commitButton = () => screen.getByRole("button", { name: /^Commit \d+ files?$/ });

    fireEvent.click(screen.getByRole("checkbox", { name: "Include notes.md in the commit" }));
    expect(commitButton().textContent).toBe("Commit 2 files");
    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: " Fix login " } });
    await act(async () => {
      fireEvent.click(commitButton());
    });

    expect(spy).toHaveBeenCalledWith(
      "commit_session_changes",
      { path: "/w/api", files: ["src/app.ts", "new.md", "old.md"], message: "Fix login" },
      undefined,
    );
    expect(screen.getByRole("status").textContent).toContain("abc1234");
    expect(props.onReload).toHaveBeenCalled();
  });

  it("shows why a commit failed", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "commit_session_changes" ? Promise.reject("Could not commit: Please tell me who you are") : Promise.resolve(undefined),
    );
    renderPanel();

    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "Fix" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Commit 3 files" }));
    });

    expect(screen.getByRole("alert").textContent).toContain("Please tell me who you are");
  });

  it("says when there is nothing to commit, without a commit box", () => {
    renderPanel({ changes: [] });

    expect(screen.getByText("No uncommitted changes.")).toBeDefined();
    expect(screen.queryByRole("textbox", { name: "Commit message" })).toBeNull();
  });
});
