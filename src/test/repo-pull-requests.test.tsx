import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, renderHook, act, waitFor, within } from "@testing-library/react";
import { useRepoPullRequests, type PullRequestSummary } from "../hooks/useRepoPullRequests";
import { PullRequestList, repoLabelOf } from "../components/changes/PullRequestList";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function pr(number: number, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number,
    title: `Change number ${number}`,
    url: `https://github.com/o/agent-desktop/pull/${number}`,
    state: "merged",
    isDraft: false,
    ...overrides,
  };
}

/** Newest first, as gh lists them. */
const SEVEN = [7, 6, 5, 4, 3, 2, 1].map((n) => pr(n));

describe("useRepoPullRequests", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the folder's pull requests, and again when the window regains focus or a turn ends", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "repo_pull_requests" ? Promise.resolve(SEVEN) : Promise.resolve(undefined),
    );
    const { result, rerender } = renderHook(({ turns }) => useRepoPullRequests("/w/api", turns, () => {}), {
      initialProps: { turns: 0 },
    });

    await waitFor(() => expect(result.current).toEqual(SEVEN));
    expect(spy).toHaveBeenCalledWith("repo_pull_requests", { path: "/w/api" }, undefined);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    rerender({ turns: 1 });

    await waitFor(() => expect(spy.mock.calls.filter(([cmd]) => cmd === "repo_pull_requests")).toHaveLength(3));
  });

  it("asks for nothing without a folder, and reports a failure once with no list shown", async () => {
    const onError = vi.fn();
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "repo_pull_requests" ? Promise.reject("gh: not logged in") : Promise.resolve(undefined),
    );
    renderHook(() => useRepoPullRequests(undefined, 0, onError));
    expect(spy.mock.calls.some(([cmd]) => cmd === "repo_pull_requests")).toBe(false);

    const { result, rerender } = renderHook(({ turns }) => useRepoPullRequests("/w/api", turns, onError), {
      initialProps: { turns: 0 },
    });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    rerender({ turns: 1 });
    await waitFor(() => expect(spy.mock.calls.filter(([cmd]) => cmd === "repo_pull_requests")).toHaveLength(2));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain("not logged in");
    expect(result.current).toBeNull();
  });

  it("shows no list when the folder is off GitHub or gh is missing", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "repo_pull_requests" ? Promise.resolve(null) : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => useRepoPullRequests("/w/api", 0, () => {}));

    await act(async () => {});
    expect(result.current).toBeNull();
  });
});

describe("repoLabelOf", () => {
  it("names the repository from a pull request's link", () => {
    expect(repoLabelOf(pr(14))).toBe("agent-desktop #14");
    expect(repoLabelOf(pr(3, { url: "not a link" }))).toBe("#3");
  });
});

describe("PullRequestList", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the five newest, oldest first, and all of them on request", () => {
    render(<PullRequestList pullRequests={SEVEN} onOpen={() => {}} />);

    const list = () => within(screen.getByRole("list", { name: "Pull requests" }));
    expect(list().getAllByRole("listitem").map((item) => item.textContent)).toEqual(
      [3, 4, 5, 6, 7].map((n) => `Change number ${n}agent-desktop #${n}`),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show all (7)" }));
    expect(list().getAllByRole("listitem")).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(list().getAllByRole("listitem")).toHaveLength(5);
  });

  it("names each pull request's state", () => {
    render(
      <PullRequestList
        pullRequests={[pr(1, { state: "open" }), pr(2, { state: "open", isDraft: true }), pr(3, { state: "closed" }), pr(4)]}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByLabelText("Open")).toBeDefined();
    expect(screen.getByLabelText("Draft")).toBeDefined();
    expect(screen.getByLabelText("Closed")).toBeDefined();
    expect(screen.getByLabelText("Merged")).toBeDefined();
  });

  it("opens a pull request from its row or its menu, and copies its link", async () => {
    const onOpen = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<PullRequestList pullRequests={[pr(9)]} onOpen={onOpen} />);

    fireEvent.click(screen.getByRole("button", { name: /Change number 9/ }));
    expect(onOpen).toHaveBeenCalledWith("https://github.com/o/agent-desktop/pull/9");

    fireEvent.click(screen.getByRole("button", { name: "More actions for #9" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy link" }));
    });
    expect(writeText).toHaveBeenCalledWith("https://github.com/o/agent-desktop/pull/9");
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More actions for #9" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in browser" }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("places its menu on screen, opening upward from a row near the bottom, so the list cannot clip it", () => {
    render(<PullRequestList pullRequests={[pr(9)]} onOpen={() => {}} />);
    const button = screen.getByRole("button", { name: "More actions for #9" });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      { top: window.innerHeight - 30, bottom: window.innerHeight - 10, left: 0, right: window.innerWidth - 20 } as DOMRect,
    );

    fireEvent.click(button);

    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("fixed");
    expect(menu.style.bottom).toBe("34px");
    expect(menu.style.top).toBe("");
    expect(menu.style.right).toBe("20px");
    // Another part of the window scrolling (the chat following a reply) leaves it open.
    const chat = document.createElement("div");
    document.body.appendChild(chat);
    fireEvent.scroll(chat);
    expect(screen.getByRole("menu")).toBeDefined();
    fireEvent.scroll(window);
    expect(screen.queryByRole("menu")).toBeNull();
    chat.remove();
  });

  it("closes its menu when the list it sits in scrolls", () => {
    render(
      <div data-testid="list-scroller">
        <PullRequestList pullRequests={[pr(9)]} onOpen={() => {}} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "More actions for #9" }));

    fireEvent.scroll(screen.getByTestId("list-scroller"));

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows at most 30, and says there are more when the backend read one past that", () => {
    const many = Array.from({ length: 31 }, (_, i) => pr(31 - i));
    render(<PullRequestList pullRequests={many} onOpen={() => {}} />);

    expect(screen.getByRole("button", { name: /Pull requests \(30\+\)/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Show all (30+)" }));
    expect(within(screen.getByRole("list", { name: "Pull requests" })).getAllByRole("listitem")).toHaveLength(30);
  });

  it("folds away and back", () => {
    render(<PullRequestList pullRequests={[pr(1)]} onOpen={() => {}} />);

    const toggle = screen.getByRole("button", { name: /Pull requests/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByRole("list", { name: "Pull requests" })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("list", { name: "Pull requests" })).toBeDefined();
  });

  it("says so when the user has no pull requests here", () => {
    render(<PullRequestList pullRequests={[]} onOpen={() => {}} />);

    expect(screen.getByText("No pull requests of yours here yet.")).toBeDefined();
  });
});
