import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, renderHook, act, waitFor } from "@testing-library/react";
import { MAX_FAILED_READS, usePullRequest, type PullRequestStatus } from "../hooks/usePullRequest";
import { PullRequestChip } from "../components/topbar/PullRequestChip";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

const OPEN: PullRequestStatus = {
  branch: "feat/x",
  number: 12,
  title: "Move session actions",
  url: "https://github.com/o/r/pull/12",
  state: "open",
  isDraft: false,
  checks: { passing: 2, failing: 0, pending: 0 },
};

describe("usePullRequest", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the branch's pull request, and again when the window regains focus or a turn ends", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "session_pull_request" ? Promise.resolve(OPEN) : Promise.resolve(undefined),
    );
    const { result, rerender } = renderHook(({ turns }) => usePullRequest("/w/api", "feat/x", turns), {
      initialProps: { turns: 0 },
    });

    await waitFor(() => expect(result.current).toEqual(OPEN));
    // The backend reads the branch checked out right now, so a branch the agent made counts at once.
    expect(spy).toHaveBeenCalledWith("session_pull_request", { path: "/w/api" }, undefined);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    rerender({ turns: 1 });

    await waitFor(() => expect(spy.mock.calls.filter(([cmd]) => cmd === "session_pull_request")).toHaveLength(3));
  });

  it("asks for nothing outside a repository, and a failed read stays quiet while it keeps retrying", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "session_pull_request" ? Promise.reject("gh: not logged in") : Promise.resolve(undefined),
    );
    renderHook(() => usePullRequest(undefined, "feat/x", 0));
    expect(spy.mock.calls.some(([cmd]) => cmd === "session_pull_request")).toBe(false);

    const { result, rerender } = renderHook(({ turns }) => usePullRequest("/w/api", "feat/x", turns), {
      initialProps: { turns: 0 },
    });
    await waitFor(() =>
      expect(spy.mock.calls.filter(([cmd]) => cmd === "session_pull_request")).toHaveLength(1),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    rerender({ turns: 1 });
    await waitFor(() =>
      expect(spy.mock.calls.filter(([cmd]) => cmd === "session_pull_request")).toHaveLength(3),
    );

    expect(result.current).toBeNull();
  });
});

describe("usePullRequest after a failure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the last pull request shown after a failed refresh, then replaces it", async () => {
    let fail = false;
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "session_pull_request" ? (fail ? Promise.reject("gh did not answer within 20 seconds") : Promise.resolve(OPEN)) : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => usePullRequest("/w/api", "feat/x", 0));
    await waitFor(() => expect(result.current).toEqual(OPEN));

    fail = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current).toEqual(OPEN);

    fail = false;
    spy.mockImplementation((cmd) =>
      cmd === "session_pull_request"
        ? Promise.resolve({ ...OPEN, state: "merged", checks: { passing: 3, failing: 0, pending: 0 } })
        : Promise.resolve(undefined),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(result.current?.state).toBe("merged"));
    expect(result.current?.checks.passing).toBe(3);
  });
});

describe("usePullRequest when reads keep failing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stops showing a pull request it can no longer read, without a notice", async () => {
    // Signed out of gh, the last checks seen would otherwise stay shown forever.
    let fail = false;
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "session_pull_request" ? (fail ? Promise.reject("gh: not logged in") : Promise.resolve(OPEN)) : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => usePullRequest("/w/api", "feat/x", 0));
    await waitFor(() => expect(result.current).toEqual(OPEN));

    fail = true;
    for (let i = 1; i < MAX_FAILED_READS; i += 1) {
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
    }
    // One slow read, or a few, is a blip: the last pull request stays.
    expect(result.current).toEqual(OPEN);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current).toBeNull();
  });
});

describe("usePullRequest across a branch switch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows a pull request only beside the branch it belongs to, and reads it again for a new branch", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "session_pull_request" ? Promise.resolve(OPEN) : Promise.resolve(undefined),
    );
    const { result, rerender } = renderHook(({ branch }) => usePullRequest("/w/api", branch, 0), {
      initialProps: { branch: "feat/x" },
    });
    await waitFor(() => expect(result.current).toEqual(OPEN));

    spy.mockImplementation(() => new Promise(() => {}));
    rerender({ branch: "feat/y" });

    // The new branch's answer is still coming: the old branch's pull request is not shown beside it.
    expect(result.current).toBeNull();
    expect(spy.mock.calls.filter(([cmd]) => cmd === "session_pull_request")).toHaveLength(2);
  });
});

describe("PullRequestChip", () => {
  it("names the pull request, its state and its checks, and opens it", () => {
    const onOpen = vi.fn();
    render(<PullRequestChip pullRequest={{ ...OPEN, checks: { passing: 1, failing: 1, pending: 0 } }} onOpen={onOpen} />);

    const chip = screen.getByRole("button", { name: "Pull request #12, open, checks failing" });
    expect(chip.textContent).toContain("#12");
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith("https://github.com/o/r/pull/12");
  });

  it("says when checks pass, are running, or there are none, and when it is a draft or merged", () => {
    const { rerender } = render(<PullRequestChip pullRequest={OPEN} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: "Pull request #12, open, checks passing" })).toBeDefined();

    rerender(<PullRequestChip pullRequest={{ ...OPEN, isDraft: true, checks: { passing: 1, failing: 0, pending: 1 } }} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: "Pull request #12, draft, checks running" })).toBeDefined();

    rerender(<PullRequestChip pullRequest={{ ...OPEN, state: "merged", checks: { passing: 0, failing: 0, pending: 0 } }} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: "Pull request #12, merged" })).toBeDefined();
  });
});
