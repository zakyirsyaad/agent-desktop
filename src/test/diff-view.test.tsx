import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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
    expect(screen.getAllByText("10").length).toBeGreaterThan(0);
    expect(screen.getAllByText("11").length).toBeGreaterThan(0);
  });

  it("notes a binary file without reading it", () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");
    renderSection({ ...STAT, isBinary: true }, true);

    expect(screen.getByText("Binary file")).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
