import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
}));

import { useAcpEngine } from "../hooks/session-engine/useAcpEngine";
import { fakeProfiles } from "./fixtures/agents";
import type { Session } from "../types";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

const SESSION: Session = {
  id: "s-1",
  name: "Rewound",
  profileId: "qwen",
  cwd: "/Users/test/developer/zorvo",
  status: "running",
  createdAt: 1,
  transport: "acp",
};

const promptsSent = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([cmd]) => cmd === "acp_prompt").map(([, args]) => (args as { text: string }).text);

describe("useAcpEngine when the agent refuses a prompt for a sign-in", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hands the hidden context to the agent again with the message the user resends", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");
    const onAuthRequired = vi.fn();
    const { result } = renderHook(() =>
      useAcpEngine({
        sessions: [SESSION],
        agents: fakeProfiles,
        updateMessages: () => {},
        patchSession: () => {},
        reportError: () => {},
        rememberOptions: () => {},
        onAuthRequired,
      }),
    );

    await act(async () => {
      await result.current.start(SESSION, { text: "try again", context: "EARLIER CONVERSATION" });
    });
    await waitFor(() => expect(promptsSent(spy)).toHaveLength(1));
    await act(async () => {
      listeners.get("acp-event")?.({
        payload: { sessionId: "s-1", kind: "turn-end", error: `ACP_AUTH_REQUIRED:${JSON.stringify([])}` },
      });
    });
    expect(onAuthRequired).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.send("s-1", "try again");
    });

    expect(promptsSent(spy)[1]).toBe("EARLIER CONVERSATION\n\ntry again");
  });

  it("hands the hidden context over with the first message of a resumed session, then no more", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");
    const { result } = renderHook(() =>
      useAcpEngine({
        sessions: [SESSION],
        agents: fakeProfiles,
        updateMessages: () => {},
        patchSession: () => {},
        reportError: () => {},
        rememberOptions: () => {},
        onAuthRequired: () => {},
      }),
    );
    await act(async () => {
      await result.current.start(SESSION, { text: "try again", context: "EARLIER CONVERSATION" });
    });
    await waitFor(() => expect(promptsSent(spy)).toHaveLength(1));
    await act(async () => {
      listeners.get("acp-event")?.({
        payload: { sessionId: "s-1", kind: "turn-end", error: `ACP_AUTH_REQUIRED:${JSON.stringify([])}` },
      });
    });

    await act(async () => {
      await result.current.resume(SESSION, "acp-s-1", { text: "next" });
    });
    await act(async () => {
      await result.current.send("s-1", "and then");
    });

    expect(promptsSent(spy).slice(1)).toEqual(["EARLIER CONVERSATION\n\nnext", "and then"]);
  });
});

describe("useAcpEngine retryAfterSignIn", () => {
  afterEach(() => vi.restoreAllMocks());

  const callsOf = (spy: { mock: { calls: unknown[][] } }, ...commands: string[]) =>
    spy.mock.calls.filter(([cmd]) => commands.includes(cmd as string)).map(([cmd]) => cmd);

  /** Answers acp_start_session with the given agent capabilities; everything else as the default fake. */
  function spyOnInvoke(agentCapabilities: Record<string, unknown>) {
    const internals = tauriInternals();
    const original = internals.invoke.bind(internals);
    return vi.spyOn(internals, "invoke").mockImplementation((cmd, args) =>
      cmd === "acp_start_session" ? Promise.resolve({ acpSessionId: "acp-1", agentCapabilities }) : original(cmd, args),
    );
  }

  function renderEngine(session: Session) {
    return renderHook(() =>
      useAcpEngine({
        sessions: [session],
        agents: fakeProfiles,
        updateMessages: () => {},
        patchSession: () => {},
        reportError: () => {},
        rememberOptions: () => {},
        onAuthRequired: () => {},
      }),
    );
  }

  it("reopens a session refused at a prompt with session/load and sends the message", async () => {
    const spy = spyOnInvoke({ loadSession: true });
    const { result } = renderEngine({ ...SESSION, acpSessionId: "acp-1" });
    await act(async () => {
      await result.current.start(SESSION);
    });
    spy.mockClear();

    await act(async () => {
      await result.current.retryAfterSignIn("s-1", { text: "try again" });
    });

    expect(callsOf(spy, "acp_stop_session", "acp_load_session", "acp_prompt")).toEqual([
      "acp_stop_session",
      "acp_load_session",
      "acp_prompt",
    ]);
    const load = spy.mock.calls.find(([cmd]) => cmd === "acp_load_session");
    expect((load?.[1] as { acpSessionId: string }).acpSessionId).toBe("acp-1");
    expect(promptsSent(spy)).toEqual(["try again"]);
  });

  it("starts a new ACP session when the agent cannot load one", async () => {
    const spy = spyOnInvoke({});
    const { result } = renderEngine({ ...SESSION, acpSessionId: "acp-1" });
    await act(async () => {
      await result.current.start(SESSION);
    });
    spy.mockClear();

    await act(async () => {
      await result.current.retryAfterSignIn("s-1", { text: "try again" });
    });

    expect(callsOf(spy, "acp_stop_session", "acp_start_session", "acp_load_session", "acp_prompt")).toEqual([
      "acp_stop_session",
      "acp_start_session",
      "acp_prompt",
    ]);
    expect(promptsSent(spy)).toEqual(["try again"]);
  });

  it("opens a session refused at start again without stopping it", async () => {
    const spy = spyOnInvoke({});
    const { result } = renderEngine({ ...SESSION, status: "terminated" });

    await act(async () => {
      await result.current.retryAfterSignIn("s-1", { text: "try again" });
    });

    expect(callsOf(spy, "acp_stop_session", "acp_start_session", "acp_prompt")).toEqual([
      "acp_start_session",
      "acp_prompt",
    ]);
    expect(promptsSent(spy)).toEqual(["try again"]);
  });

  it("keeps the hidden context of a refused prompt", async () => {
    const spy = spyOnInvoke({});
    const { result } = renderEngine(SESSION);
    await act(async () => {
      await result.current.start(SESSION, { text: "try again", context: "EARLIER CONVERSATION" });
    });
    await waitFor(() => expect(promptsSent(spy)).toHaveLength(1));
    await act(async () => {
      listeners.get("acp-event")?.({
        payload: { sessionId: "s-1", kind: "turn-end", error: `ACP_AUTH_REQUIRED:${JSON.stringify([])}` },
      });
    });

    await act(async () => {
      await result.current.retryAfterSignIn("s-1", { text: "try again" });
    });

    expect(promptsSent(spy)[1]).toBe("EARLIER CONVERSATION\n\ntry again");
  });
});
