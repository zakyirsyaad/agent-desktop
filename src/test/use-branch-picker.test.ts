import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useBranchPicker, type BranchPickerInput } from "../hooks/useBranchPicker";
import type { Session } from "../types";

const mockInvoke = vi.fn((_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(undefined));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args),
}));

const FOLDER = "/Users/test/developer/zorvo";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    name: "Fix login",
    profileId: "qwen-code",
    cwd: FOLDER,
    status: "idle",
    createdAt: 0,
    ...overrides,
  };
}

function input(overrides: Partial<BranchPickerInput> = {}): BranchPickerInput {
  return {
    folderPath: FOLDER,
    checkedOut: "main",
    isWorktreeOn: false,
    sessions: [],
    onSwitched: vi.fn(),
    onNotice: vi.fn(),
    ...overrides,
  };
}

describe("useBranchPicker", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "list_branches" ? ["feature", "main"] : undefined),
    );
  });

  it("offers nothing outside a repository", () => {
    const { result } = renderHook(() => useBranchPicker(input({ checkedOut: undefined })));

    expect(result.current.control).toBeUndefined();
    expect(result.current.baseBranch).toBeUndefined();
  });

  it("names the checked-out branch and loads the branches when opened", async () => {
    const { result } = renderHook(() => useBranchPicker(input()));
    expect(result.current.control?.current).toBe("main");
    expect(result.current.control?.branches).toBeNull();

    act(() => result.current.control?.onOpen());

    await waitFor(() => expect(result.current.control?.branches).toEqual(["feature", "main"]));
    expect(mockInvoke).toHaveBeenCalledWith("list_branches", { path: FOLDER });
  });

  it("reports a branch list that cannot be read", async () => {
    mockInvoke.mockImplementation(() => Promise.reject("not a git repository"));
    const onNotice = vi.fn();
    const { result } = renderHook(() => useBranchPicker(input({ onNotice })));

    act(() => result.current.control?.onOpen());

    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("not a git repository")));
    expect(result.current.control?.branches).toEqual([]);
  });

  it("switches the folder itself when Worktree is off", async () => {
    const onSwitched = vi.fn();
    const { result } = renderHook(() => useBranchPicker(input({ onSwitched })));

    await act(async () => result.current.control?.onPick("feature"));

    expect(mockInvoke).toHaveBeenCalledWith("switch_branch", { path: FOLDER, branch: "feature" });
    expect(onSwitched).toHaveBeenCalled();
    expect(result.current.baseBranch).toBeUndefined();
  });

  it("does nothing when the checked-out branch is picked again", async () => {
    const { result } = renderHook(() => useBranchPicker(input()));

    await act(async () => result.current.control?.onPick("main"));

    expect(mockInvoke).not.toHaveBeenCalledWith("switch_branch", expect.anything());
  });

  it("leaves the folder alone while one of its sessions has a live agent", async () => {
    const onNotice = vi.fn();
    const { result } = renderHook(() =>
      useBranchPicker(input({ onNotice, sessions: [session({ cwd: `${FOLDER}/src` })] })),
    );

    await act(async () => result.current.control?.onPick("feature"));

    expect(mockInvoke).not.toHaveBeenCalledWith("switch_branch", expect.anything());
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Fix login"));
  });

  it("does not count ended sessions, worktree sessions or other folders", async () => {
    const { result } = renderHook(() =>
      useBranchPicker(
        input({
          sessions: [
            session({ id: "ended", status: "terminated" }),
            session({ id: "wt", worktree: { repoPath: FOLDER, path: "/wt/zorvo/x", branch: "agent/x" } }),
            session({ id: "other", cwd: "/Users/test/developer/zorvo-site" }),
          ],
        }),
      ),
    );

    await act(async () => result.current.control?.onPick("feature"));

    expect(mockInvoke).toHaveBeenCalledWith("switch_branch", { path: FOLDER, branch: "feature" });
  });

  it("reports a switch git refused", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "switch_branch" ? Promise.reject("Your local changes would be overwritten") : Promise.resolve([]),
    );
    const onNotice = vi.fn();
    const onSwitched = vi.fn();
    const { result } = renderHook(() => useBranchPicker(input({ onNotice, onSwitched })));

    await act(async () => result.current.control?.onPick("feature"));

    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Your local changes would be overwritten"));
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it("picks the worktree's starting branch when Worktree is on, without touching the folder", async () => {
    const { result } = renderHook(() => useBranchPicker(input({ isWorktreeOn: true })));
    expect(result.current.baseBranch).toBeUndefined();

    await act(async () => result.current.control?.onPick("feature"));

    expect(mockInvoke).not.toHaveBeenCalledWith("switch_branch", expect.anything());
    expect(result.current.control?.current).toBe("feature");
    expect(result.current.baseBranch).toBe("feature");
  });

  it("forgets the starting branch when the folder changes", async () => {
    const { result, rerender } = renderHook((props: BranchPickerInput) => useBranchPicker(props), {
      initialProps: input({ isWorktreeOn: true }),
    });
    await act(async () => result.current.control?.onPick("feature"));

    rerender(input({ isWorktreeOn: true, folderPath: "/Users/test/developer/other", checkedOut: "develop" }));

    expect(result.current.control?.current).toBe("develop");
    expect(result.current.baseBranch).toBeUndefined();
  });

  it("shows the checked-out branch again when Worktree is turned off", async () => {
    const { result, rerender } = renderHook((props: BranchPickerInput) => useBranchPicker(props), {
      initialProps: input({ isWorktreeOn: true }),
    });
    await act(async () => result.current.control?.onPick("feature"));

    rerender(input({ isWorktreeOn: false }));

    expect(result.current.control?.current).toBe("main");
    expect(result.current.baseBranch).toBeUndefined();
  });
});
