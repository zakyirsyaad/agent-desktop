import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentSessionList } from "../hooks/useAgentSessionList";
import type { AgentAuth } from "../hooks/useAgentAuth";
import type { ListedSessions } from "../lib/session-list";
import type { Session } from "../types";

const CWD = "/Users/test/developer/zorvo";
const PROFILE = "qwen-code";

/** A Zorvo session, as far as the list cares: it holds an agent session id or it does not. */
function zorvoSession(id: string, acpSessionId?: string, archived = false): Session {
  return {
    id,
    name: id,
    profileId: PROFILE,
    cwd: CWD,
    status: "terminated",
    createdAt: 1,
    ...(acpSessionId === undefined ? {} : { acpSessionId }),
    ...(archived ? { archivedAt: 2 } : {}),
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Deps {
  profileId: string | undefined;
  cwd: string | undefined;
  sessions: readonly Session[];
  listSessions: (profileId: string, cwd: string) => Promise<ListedSessions>;
  requestSignIn: AgentAuth["requestSignIn"];
}

function deps(overrides: Partial<Deps> = {}): Deps {
  return {
    profileId: PROFILE,
    cwd: CWD,
    sessions: [],
    listSessions: vi.fn(async () => ({ sessions: [], truncated: false, incomplete: false })),
    requestSignIn: vi.fn(),
    ...overrides,
  };
}

describe("useAgentSessionList", () => {
  it("goes from idle to loading to the sessions the agent offers", async () => {
    const answer = deferred<ListedSessions>();
    const listSessions = vi.fn(() => answer.promise);
    const { result } = renderHook(() =>
      useAgentSessionList(deps({ sessions: [zorvoSession("held", "held"), zorvoSession("old", "archived", true)], listSessions })),
    );

    expect(result.current.state).toEqual({ kind: "idle" });

    act(() => result.current.load());
    expect(result.current.state).toEqual({ kind: "loading" });
    expect(listSessions).toHaveBeenCalledWith(PROFILE, CWD);

    await act(async () => {
      answer.resolve({
        sessions: [
          { acpSessionId: "older", title: "Older", updatedAt: "2026-10-19T10:00:00Z" },
          { acpSessionId: "held", title: "Held", updatedAt: "2026-10-21T10:00:00Z" },
          { acpSessionId: "newer", title: "Newer", updatedAt: "2026-10-20T10:00:00Z" },
          { acpSessionId: "archived", title: "Archived", updatedAt: "2026-10-21T11:00:00Z" },
        ],
        truncated: true,
        incomplete: false,
      });
    });

    expect(result.current.state).toEqual({
      kind: "loaded",
      sessions: [
        { acpSessionId: "newer", title: "Newer", updatedAt: "2026-10-20T10:00:00Z" },
        { acpSessionId: "older", title: "Older", updatedAt: "2026-10-19T10:00:00Z" },
      ],
      truncated: true,
      incomplete: false,
    });
  });

  it("drops a listed session once a Zorvo session holds its id", async () => {
    const { result, rerender } = renderHook((props: Deps) => useAgentSessionList(props), { initialProps: deps() });
    const listSessions = vi.fn(async () => ({
      sessions: [
        { acpSessionId: "a", title: "A" },
        { acpSessionId: "b", title: "B" },
      ],
      truncated: false,
      incomplete: false,
    }));
    rerender(deps({ listSessions }));

    await act(async () => result.current.load());
    expect(result.current.state).toMatchObject({ kind: "loaded", sessions: [{ acpSessionId: "a" }, { acpSessionId: "b" }] });

    rerender(deps({ listSessions, sessions: [zorvoSession("s", "a")] }));

    expect(result.current.state).toMatchObject({ kind: "loaded", sessions: [{ acpSessionId: "b" }] });
  });

  it("shows the agent's error when the list fails", async () => {
    const listSessions = vi.fn(async () => {
      throw "boom";
    });
    const { result } = renderHook(() => useAgentSessionList(deps({ listSessions })));

    await act(async () => result.current.load());

    expect(result.current.state).toEqual({ kind: "failed", message: "boom" });
  });

  it("opens the draft's sign-in panel instead of failing when the agent needs a sign-in", async () => {
    const listSessions = vi.fn(async () => {
      throw `ACP_AUTH_REQUIRED:${JSON.stringify([{ id: "browser", name: "Browser" }])}`;
    });
    const requestSignIn = vi.fn();
    const { result } = renderHook(() => useAgentSessionList(deps({ listSessions, requestSignIn })));

    await act(async () => result.current.load());

    expect(result.current.state).toEqual({ kind: "idle" });
    expect(requestSignIn).toHaveBeenCalledWith(PROFILE, CWD, [{ id: "browser", name: "Browser", kind: "agent" }]);
  });

  it("ignores a list that arrives after the draft switched to another agent", async () => {
    const answer = deferred<ListedSessions>();
    const listSessions = vi.fn(() => answer.promise);
    const { result, rerender } = renderHook((props: Deps) => useAgentSessionList(props), {
      initialProps: deps({ profileId: "agent-a", listSessions }),
    });

    act(() => result.current.load());
    expect(result.current.state).toEqual({ kind: "loading" });

    rerender(deps({ profileId: "agent-b", listSessions }));
    expect(result.current.state).toEqual({ kind: "idle" });

    await act(async () => {
      answer.resolve({ sessions: [{ acpSessionId: "a1", title: "A one" }], truncated: false, incomplete: false });
    });

    expect(result.current.state).toEqual({ kind: "idle" });
  });

  it("resets to idle when the draft's folder changes", async () => {
    const { result, rerender } = renderHook((props: Deps) => useAgentSessionList(props), { initialProps: deps() });
    const listSessions = vi.fn(async () => ({
      sessions: [{ acpSessionId: "a", title: "A" }],
      truncated: false,
      incomplete: false,
    }));
    rerender(deps({ listSessions }));

    await act(async () => result.current.load());
    expect(result.current.state).toMatchObject({ kind: "loaded" });

    rerender(deps({ listSessions, cwd: "/Users/test/developer/elsewhere" }));

    expect(result.current.state).toEqual({ kind: "idle" });
  });

  it("keeps an import error apart from the list state until it is cleared", () => {
    const { result } = renderHook(() => useAgentSessionList(deps()));

    expect(result.current.importError).toBeNull();

    act(() => result.current.setImportError("Import failed: boom"));
    expect(result.current.importError).toBe("Import failed: boom");
    expect(result.current.state).toEqual({ kind: "idle" });

    act(() => result.current.setImportError(null));
    expect(result.current.importError).toBeNull();
  });
});