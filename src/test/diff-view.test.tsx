import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { DiffStatChip } from "../components/changes/DiffStatChip";
import { DiffFileSection } from "../components/changes/DiffFileSection";
import { DiffView } from "../components/changes/DiffView";
import type { FileStat } from "../lib/diff-stats";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

const DIFF = "@@ -10,2 +10,2 @@\n context\n-old\n+new\n";

const STAT: FileStat = { path: "src/lib/app.ts", oldPath: null, kind: "modified", added: 3, removed: 1, isBinary: false, fingerprint: "f1" };

function renderSection(stat: FileStat, isOpen: boolean) {
  return render(
    <DiffFileSection rootPath="/w" stat={stat} target="base" version={1} isOpen={isOpen} onToggle={() => {}} />,
  );
}

describe("DiffStatChip", () => {
  it("shows the counts and opens the diff", () => {
    const onOpen = vi.fn();
    render(<DiffStatChip added={2847} removed={35} onOpen={onOpen} />);

    const button = screen.getByRole("button", { name: "2,847 lines added, 35 removed. Open the diff" });
    expect(button.textContent).toContain("+2,847");
    expect(button.textContent).toContain("−35");
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("renders nothing without changes", () => {
    const { container } = render(<DiffStatChip added={0} removed={0} onOpen={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("DiffFileSection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stays closed without reading the diff", () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");
    renderSection(STAT, false);

    const header = screen.getByRole("button", { expanded: false });
    expect(header.textContent).toContain("app.ts");
    expect(header.textContent).toContain("src/lib");
    expect(header.textContent).toContain("+3");
    expect(header.textContent).toContain("−1");
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads the diff against the target and numbers the lines when open", async () => {
    const spy = vi
      .spyOn(tauriInternals(), "invoke")
      .mockImplementation((cmd) => Promise.resolve(cmd === "session_file_diff" ? DIFF : undefined));
    await act(async () => {
      renderSection(STAT, true);
    });

    expect(spy).toHaveBeenCalledWith(
      "session_file_diff",
      { path: "/w", file: "src/lib/app.ts", target: "base" },
      undefined,
    );
    const gutters = (kind: string) =>
      Array.from(document.querySelector(`[data-line="${kind}"]`)!.children)
        .slice(0, 2)
        .map((cell) => cell.textContent);
    expect(gutters("context")).toEqual(["10", "10"]);
    expect(gutters("removed")).toEqual(["11", ""]);
    expect(gutters("added")).toEqual(["", "11"]);
  });

  it("notes a binary file without reading it", () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");
    renderSection({ ...STAT, isBinary: true }, true);

    expect(screen.getByText("Binary file")).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("toggles when the header is clicked", () => {
    const onToggle = vi.fn();
    render(<DiffFileSection rootPath="/w" stat={STAT} target="base" version={1} isOpen={false} onToggle={onToggle} />);

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("titles a renamed file with where it came from", () => {
    renderSection({ ...STAT, oldPath: "src/old.ts", kind: "renamed" }, false);

    expect(screen.getByRole("button", { expanded: false }).getAttribute("title")).toBe("src/old.ts → src/lib/app.ts");
  });

  it("titles a plain file with its path", () => {
    renderSection(STAT, false);

    expect(screen.getByRole("button", { expanded: false }).getAttribute("title")).toBe("src/lib/app.ts");
  });

  it("drops the diff of the previous target while the new one is read", async () => {
    let resolveBase: (diff: string) => void = () => {};
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((_cmd, args) =>
      args?.target === "head"
        ? Promise.resolve("@@ -1 +1 @@\n-alpha\n+beta\n")
        : new Promise<string>((resolve) => {
            resolveBase = resolve;
          }),
    );
    const view = (target: "head" | "base") => (
      <DiffFileSection rootPath="/w" stat={STAT} target={target} version={1} isOpen onToggle={() => {}} />
    );
    const { rerender } = render(view("head"));
    await act(async () => {});
    expect(screen.getByText("beta")).toBeDefined();

    rerender(view("base"));

    expect(screen.queryByText("beta")).toBeNull();
    expect(screen.getByText("Loading the diff…")).toBeDefined();
    await act(async () => resolveBase("@@ -1 +1 @@\n-x\n+gamma\n"));
    expect(within(screen.getByLabelText("Diff of src/lib/app.ts")).getByText("gamma")).toBeDefined();
  });
});

const statOf = (path: string, fingerprint = "f1"): FileStat => ({ path, oldPath: null, kind: "modified", added: 1, removed: 1, isBinary: false, fingerprint });

function mockDiff(stats: FileStat[], targets: { base: { name: string } | null } = { base: { name: "main" } }) {
  return vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) => {
    if (cmd === "session_diff_targets") return Promise.resolve(targets);
    if (cmd === "session_diff_stats") return Promise.resolve(stats);
    return Promise.resolve("");
  });
}

async function renderView(props: Partial<React.ComponentProps<typeof DiffView>> = {}) {
  const handlers = { onToggleExpanded: vi.fn(), onClose: vi.fn(), onError: vi.fn() };
  await act(async () => {
    render(<DiffView rootPath="/w" version={1} isExpanded={false} {...handlers} {...props} />);
  });
  return handlers;
}

const THREE = [statOf("src/app.ts"), statOf("src/lib/util.ts"), statOf("README.md")];
const statCalls = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => c[0] === "session_diff_stats");

describe("DiffView", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows what is compared and compares against the base first", async () => {
    const spy = mockDiff(THREE);
    await renderView();

    expect(screen.getByRole("button", { name: "Diff target: main → working tree" })).toBeDefined();
    expect(statCalls(spy).map((c) => (c[1] as { target: string }).target)).toEqual(["base"]);
  });

  it("reads HEAD and reports once when the targets cannot be read", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "session_diff_targets"
        ? Promise.reject("boom")
        : Promise.resolve(cmd === "session_diff_stats" ? THREE : ""),
    );
    const { onError } = await renderView();

    expect(statCalls(spy).map((c) => (c[1] as { target: string }).target)).toEqual(["head"]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toContain("/w");
    expect(screen.getByText("HEAD → working tree")).toBeDefined();
  });

  it("reads against HEAD after choosing it in the dropdown", async () => {
    const spy = mockDiff(THREE);
    await renderView();

    fireEvent.click(screen.getByRole("button", { name: "Diff target: main → working tree" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "HEAD → working tree" }));
    });

    expect(spy).toHaveBeenCalledWith("session_diff_stats", { path: "/w", target: "head" }, undefined);
    expect(screen.getByRole("button", { name: "Diff target: HEAD → working tree" })).toBeDefined();
  });

  it("falls back to HEAD when a chosen base goes away", async () => {
    let targets: { base: { name: string } | null } = { base: { name: "main" } };
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) => {
      if (cmd === "session_diff_targets") return Promise.resolve(targets);
      if (cmd === "session_diff_stats") return Promise.resolve(THREE);
      return Promise.resolve("");
    });
    const handlers = { onToggleExpanded: vi.fn(), onClose: vi.fn(), onError: vi.fn() };
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      ({ rerender } = render(<DiffView rootPath="/w" version={1} isExpanded={false} {...handlers} />));
    });
    fireEvent.click(screen.getByRole("button", { name: "Diff target: main → working tree" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "main → working tree" }));
    });

    // The user checks out main: there is no base to compare with any more.
    targets = { base: null };
    await act(async () => {
      rerender(<DiffView rootPath="/w" version={2} isExpanded={false} {...handlers} />);
    });

    expect(screen.getByText("HEAD → working tree")).toBeDefined();
    expect(statCalls(spy).at(-1)?.[1]).toEqual({ path: "/w", target: "head" });
  });

  it("shows plain text without a dropdown when there is no base", async () => {
    const spy = mockDiff(THREE, { base: null });
    await renderView();

    expect(screen.getByText("HEAD → working tree")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Diff target/ })).toBeNull();
    expect(spy).toHaveBeenCalledWith("session_diff_stats", { path: "/w", target: "head" }, undefined);
  });

  it("filters the files by the search text", async () => {
    mockDiff(THREE);
    await renderView();

    fireEvent.click(screen.getByRole("button", { name: "Search files" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), { target: { value: "app" } });

    expect(screen.getByText("app.ts")).toBeDefined();
    expect(screen.queryByText("util.ts")).toBeNull();
    expect(screen.queryByText("README.md")).toBeNull();
  });

  it("collapses and expands every section from the menu", async () => {
    mockDiff(THREE);
    await renderView();
    const expandedStates = () => screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-expanded") && b.hasAttribute("title") && b.getAttribute("aria-haspopup") === null).map((b) => b.getAttribute("aria-expanded"));
    expect(expandedStates()).toEqual(["true", "true", "true"]);

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Collapse all" }));
    expect(expandedStates()).toEqual(["false", "false", "false"]);

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Expand all" }));
    });
    expect(expandedStates()).toEqual(["true", "true", "true"]);
  });

  it("reads the stats again on Refresh", async () => {
    const spy = mockDiff(THREE);
    await renderView();
    const before = statCalls(spy).length;

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));
    });

    expect(statCalls(spy).length).toBe(before + 1);
  });

  it("reads an open file's diff again only when the file changed", async () => {
    let stats = THREE;
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) => {
      if (cmd === "session_diff_targets") return Promise.resolve({ base: null });
      if (cmd === "session_diff_stats") return Promise.resolve(stats);
      return Promise.resolve("@@ -1 +1 @@\n-a\n+b\n");
    });
    const handlers = { onToggleExpanded: vi.fn(), onClose: vi.fn(), onError: vi.fn() };
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      ({ rerender } = render(<DiffView rootPath="/w" version={1} isExpanded={false} {...handlers} />));
    });
    const diffReads = () => spy.mock.calls.filter((c) => c[0] === "session_file_diff").map((c) => (c[1] as { file: string }).file);
    expect(diffReads()).toHaveLength(3);

    // The list is read again (window focus) but nothing changed: no diff is read.
    await act(async () => {
      rerender(<DiffView rootPath="/w" version={2} isExpanded={false} {...handlers} />);
    });
    expect(diffReads()).toHaveLength(3);

    // One file changed: only its diff is read again.
    stats = [statOf("src/app.ts", "f2"), statOf("src/lib/util.ts"), statOf("README.md")];
    await act(async () => {
      rerender(<DiffView rootPath="/w" version={3} isExpanded={false} {...handlers} />);
    });
    expect(diffReads().slice(3)).toEqual(["src/app.ts"]);
  });

  it("reads a few diffs at a time when many sections are open", async () => {
    const files = Array.from({ length: 10 }, (_, i) => statOf(`src/f${i}.ts`));
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) => {
      if (cmd === "session_diff_targets") return Promise.resolve({ base: null });
      if (cmd === "session_diff_stats") return Promise.resolve(files);
      return new Promise(() => {});
    });
    await renderView();

    expect(spy.mock.calls.filter((c) => c[0] === "session_file_diff")).toHaveLength(4);
  });

  it("opens a small list after switching away from a large one", async () => {
    const many = Array.from({ length: 26 }, (_, i) => statOf(`src/f${i}.ts`));
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) => {
      if (cmd === "session_diff_targets") return Promise.resolve({ base: { name: "main" } });
      if (cmd === "session_diff_stats") return Promise.resolve((args as { target: string }).target === "base" ? many : THREE);
      return Promise.resolve("");
    });
    await renderView();
    const sections = () => screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-expanded") && b.hasAttribute("title") && b.getAttribute("aria-haspopup") === null);
    expect(sections().every((b) => b.getAttribute("aria-expanded") === "false")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Diff target: main → working tree" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "HEAD → working tree" }));
    });

    expect(sections().map((b) => b.getAttribute("aria-expanded"))).toEqual(["true", "true", "true"]);
  });

  it("hands expand and close to its owner", async () => {
    mockDiff(THREE);
    const { onToggleExpanded, onClose } = await renderView();

    fireEvent.click(screen.getByRole("button", { name: "Expand diff view" }));
    fireEvent.click(screen.getByRole("button", { name: "Close diff view" }));

    expect(onToggleExpanded).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("starts every section collapsed above 25 files", async () => {
    mockDiff(Array.from({ length: 26 }, (_, i) => statOf(`src/f${i}.ts`)));
    await renderView();

    const headers = screen.getAllByRole("button").filter((b) => b.getAttribute("title")?.startsWith("src/f"));
    expect(headers).toHaveLength(26);
    expect(headers.every((b) => b.getAttribute("aria-expanded") === "false")).toBe(true);
  });

  it("keeps the user's choices when a later list crosses the limit", async () => {
    mockDiff(THREE);
    const view = render(<DiffView rootPath="/w" version={1} isExpanded={false} onToggleExpanded={() => {}} onClose={() => {}} onError={() => {}} />);
    await act(async () => {});
    mockDiff(Array.from({ length: 26 }, (_, i) => statOf(`src/f${i}.ts`)).concat(THREE));
    await act(async () => view.rerender(<DiffView rootPath="/w" version={2} isExpanded={false} onToggleExpanded={() => {}} onClose={() => {}} onError={() => {}} />));

    expect(screen.getByTitle("src/app.ts").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTitle("src/f0.ts").getAttribute("aria-expanded")).toBe("false");
  });

  it("says there are no changes against the compared branch", async () => {
    mockDiff([]);
    await renderView();
    expect(screen.getByText("No changes against main.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Diff target: main → working tree" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "HEAD → working tree" }));
    });
    expect(screen.getByText("No changes against HEAD.")).toBeDefined();
  });
});
