import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { DiffStatChip } from "../components/changes/DiffStatChip";
import { DiffFileSection } from "../components/changes/DiffFileSection";
import type { FileStat } from "../lib/diff-stats";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

const DIFF = "@@ -10,2 +10,2 @@\n context\n-old\n+new\n";

const STAT: FileStat = { path: "src/lib/app.ts", oldPath: null, kind: "modified", added: 3, removed: 1, isBinary: false };

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
