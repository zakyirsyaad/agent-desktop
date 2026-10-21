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
import { userMessage } from "../lib/session-helpers";
import type { ChatMessage, Session } from "../types";

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

  /** Answers the given commands itself; everything else as the default fake. */
  function spyWith(overrides: Record<string, (args: Record<string, unknown> | undefined) => Promise<unknown>>) {
    const internals = tauriInternals();
    const original = internals.invoke.bind(internals);
    return vi.spyOn(internals, "invoke").mockImplementation((cmd, args) => {
      const override = overrides[cmd];
      return override ? override(args) : original(cmd, args);
    });
  }

  /** Renders the engine over one session; rerender it with the session as the app has it by then. */
  function renderEngine(
    session: Session,
    patchSession: (sessionId: string, patch: Partial<Session>) => void = () => {},
    transcripts: Readonly<Record<string, ChatMessage[]>> = {},
  ) {
    return renderHook(
      ({ current }: { current: Session }) =>
        useAcpEngine({
          sessions: [current],
          agents: fakeProfiles,
          transcripts,
          updateMessages: () => {},
          patchSession,
          reportError: () => {},
          rememberOptions: () => {},
          onAuthRequired: () => {},
        }),
      { initialProps: { current: session } },
    );
  }

  const refuseAtPrompt = async () => {
    await act(async () => {
      listeners.get("acp-event")?.({
        payload: { sessionId: "s-1", kind: "turn-end", error: `ACP_AUTH_REQUIRED:${JSON.stringify([])}` },
      });
    });
  };

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

    expect(callsOf(spy, "acp_stop_session", "acp_reopen_session", "acp_prompt")).toEqual([
      "acp_stop_session",
      "acp_reopen_session",
      "acp_prompt",
    ]);
    const load = spy.mock.calls.find(([cmd]) => cmd === "acp_reopen_session");
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

    expect(callsOf(spy, "acp_stop_session", "acp_start_session", "acp_reopen_session", "acp_prompt")).toEqual([
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

  it("starts a new ACP session when the agent cannot load a session refused at a prompt", async () => {
    let starts = 0;
    const spy = spyWith({
      acp_start_session: () => Promise.resolve({ acpSessionId: `acp-${++starts}`, agentCapabilities: { loadSession: true } }),
      acp_reopen_session: () => Promise.reject("session/load failed: Resource not found: acp-1"),
    });
    const { result } = renderEngine({ ...SESSION, acpSessionId: "acp-1" });
    await act(async () => {
      await result.current.start(SESSION);
    });
    spy.mockClear();

    let isHandled: boolean | undefined;
    await act(async () => {
      isHandled = await result.current.retryAfterSignIn("s-1", { text: "try again" });
    });

    expect(callsOf(spy, "acp_stop_session", "acp_reopen_session", "acp_start_session", "acp_prompt")).toEqual([
      "acp_stop_session",
      "acp_reopen_session",
      "acp_start_session",
      "acp_prompt",
    ]);
    expect(promptsSent(spy)).toEqual(["try again"]);
    expect(isHandled).toBe(true);
  });

  it.each([
    ["the agent fails the load", "session/load failed: Internal error: disk full"],
    ["the agent never answers", "Timed out waiting for session/load"],
  ])("keeps a session refused at a prompt, and gives the message back, when %s", async (_case, loadError) => {
    let starts = 0;
    const spy = spyWith({
      acp_start_session: () => Promise.resolve({ acpSessionId: `acp-${++starts}`, agentCapabilities: { loadSession: true } }),
      acp_reopen_session: () => Promise.reject(loadError),
    });
    const { result } = renderEngine({ ...SESSION, acpSessionId: "acp-1" });
    await act(async () => {
      await result.current.start(SESSION);
    });
    spy.mockClear();

    let isHandled: boolean | undefined;
    await act(async () => {
      isHandled = await result.current.retryAfterSignIn("s-1", { text: "try again" });
    });

    // A fresh ACP session would lose the conversation the agent still has.
    expect(callsOf(spy, "acp_reopen_session", "acp_start_session")).toEqual(["acp_reopen_session"]);
    expect(promptsSent(spy)).toEqual([]);
    expect(isHandled).toBe(false);
  });

  /** The hidden context a fresh ACP session is handed: the conversation so far, in a file. */
  const HANDOFF = /^Read the file "\/fake\/app-data\/handoffs\/[^"]+\.md" for this conversation so far/;
  const EARLIER = { "s-1": [userMessage("what does main.rs do?")] };

  it("hands the conversation to a new ACP session when the agent cannot load one", async () => {
    let starts = 0;
    const spy = spyWith({
      acp_start_session: () => Promise.resolve({ acpSessionId: `acp-${++starts}`, agentCapabilities: {} }),
    });
    const { result } = renderEngine({ ...SESSION, acpSessionId: "acp-1" }, () => {}, EARLIER);
    await act(async () => {
      await result.current.start(SESSION);
    });
    spy.mockClear();

    await act(async () => {
      await result.current.retryAfterSignIn("s-1", { text: "try again" });
    });

    expect(callsOf(spy, "write_fork_handoff", "acp_start_session", "acp_prompt")).toEqual([
      "write_fork_handoff",
      "acp_start_session",
      "acp_prompt",
    ]);
    expect(promptsSent(spy)[0]).toMatch(HANDOFF);
    expect(promptsSent(spy)[0]).toMatch(/\n\ntry again$/);
  });

  it("continues a resume-only agent after a sign-in", async () => {
    const spy = spyOnInvoke({ sessionCapabilities: { resume: {} } });
    const { result } = renderEngine({ ...SESSION, acpSessionId: "acp-1" }, () => {}, EARLIER);
    await act(async () => {
      await result.current.start(SESSION);
    });
    await refuseAtPrompt();
    spy.mockClear();

    await act(async () => {
      await result.current.retryAfterSignIn("s-1", { text: "try again" });
    });

    expect(callsOf(spy, "acp_stop_session", "write_fork_handoff", "acp_start_session", "acp_reopen_session", "acp_prompt")).toEqual([
      "acp_stop_session",
      "acp_reopen_session",
      "acp_prompt",
    ]);
    expect(promptsSent(spy)).toEqual(["try again"]);
  });

  it("hands the conversation to a new ACP session when the agent no longer knows the old one", async () => {
    let starts = 0;
    const spy = spyWith({
      acp_start_session: () => Promise.resolve({ acpSessionId: `acp-${++starts}`, agentCapabilities: { loadSession: true } }),
      acp_reopen_session: () => Promise.reject("session/load failed: Resource not found: acp-1"),
    });
    const { result } = renderEngine({ ...SESSION, acpSessionId: "acp-1" }, () => {}, EARLIER);
    await act(async () => {
      await result.current.start(SESSION);
    });
    spy.mockClear();

    await act(async () => {
      await result.current.retryAfterSignIn("s-1", { text: "try again" });
    });

    expect(callsOf(spy, "acp_reopen_session", "write_fork_handoff", "acp_start_session")).toEqual([
      "acp_reopen_session",
      "write_fork_handoff",
      "acp_start_session",
    ]);
    expect(promptsSent(spy)[0]).toMatch(HANDOFF);
  });

  it("leaves no handoff behind when the new ACP session does not open", async () => {
    let starts = 0;
    const spy = spyWith({
      acp_start_session: () =>
        starts++ === 0
          ? Promise.resolve({ acpSessionId: "acp-1", agentCapabilities: { loadSession: true } })
          : Promise.reject("spawn failed"),
      acp_reopen_session: () => Promise.reject("session/load failed: Resource not found: acp-1"),
    });
    const { result } = renderEngine({ ...SESSION, acpSessionId: "acp-1" }, () => {}, EARLIER);
    await act(async () => {
      await result.current.start(SESSION);
    });
    await act(async () => {
      await result.current.retryAfterSignIn("s-1", { text: "try again" });
    });
    spy.mockClear();

    await act(async () => {
      await result.current.send("s-1", "hello again");
    });

    expect(promptsSent(spy)).toEqual(["hello again"]);
  });

  it("gives the message back when neither a load nor a new session opens", async () => {
    let starts = 0;
    const spy = spyWith({
      acp_start_session: () =>
        starts++ === 0
          ? Promise.resolve({ acpSessionId: "acp-1", agentCapabilities: { loadSession: true } })
          : Promise.reject("spawn failed"),
      acp_reopen_session: () => Promise.reject("session/load failed: Resource not found: acp-1"),
    });
    const { result } = renderEngine({ ...SESSION, acpSessionId: "acp-1" });
    await act(async () => {
      await result.current.start(SESSION);
    });
    spy.mockClear();

    let isHandled: boolean | undefined;
    await act(async () => {
      isHandled = await result.current.retryAfterSignIn("s-1", { text: "try again" });
    });

    expect(callsOf(spy, "acp_start_session")).toHaveLength(1);
    expect(promptsSent(spy)).toEqual([]);
    expect(isHandled).toBe(false);
  });

  it("gives the message back, and keeps the hidden context, when the agent cannot be stopped", async () => {
    const spy = spyWith({ acp_stop_session: () => Promise.reject("stop failed") });
    const { result } = renderEngine(SESSION);
    await act(async () => {
      await result.current.start(SESSION, { text: "try again", context: "EARLIER CONVERSATION" });
    });
    await waitFor(() => expect(promptsSent(spy)).toHaveLength(1));
    await refuseAtPrompt();

    let isHandled: boolean | undefined;
    await act(async () => {
      isHandled = await result.current.retryAfterSignIn("s-1", { text: "try again" });
    });
    await act(async () => {
      await result.current.send("s-1", "try again");
    });

    expect(isHandled).toBe(false);
    expect(callsOf(spy, "acp_reopen_session", "acp_start_session")).toEqual(["acp_start_session"]);
    expect(promptsSent(spy)[1]).toBe("EARLIER CONVERSATION\n\ntry again");
  });

  it("marks a session refused at start running again before it opens it", async () => {
    spyWith({});
    const patchSession = vi.fn();
    const { result } = renderEngine({ ...SESSION, status: "terminated", archivedAt: 5 }, patchSession);

    await act(async () => {
      await result.current.retryAfterSignIn("s-1", { text: "try again" });
    });

    expect(patchSession).toHaveBeenCalledWith("s-1", { status: "running", endedAt: null, exitCode: null, archivedAt: null });
  });

  it("starts a session refused at start with the picks it was started with", async () => {
    let starts = 0;
    const model = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "fast",
      options: [
        { value: "fast", name: "Fast" },
        { value: "smart", name: "Smart" },
      ],
    };
    const spy = spyWith({
      acp_start_session: () =>
        starts++ === 0
          ? Promise.reject(`ACP_AUTH_REQUIRED:${JSON.stringify([])}`)
          : Promise.resolve({ acpSessionId: "acp-1", configOptions: [model] }),
      acp_set_config_option: () => Promise.resolve([{ ...model, currentValue: "smart" }]),
    });
    const { result, rerender } = renderEngine(SESSION);
    await act(async () => {
      await result.current.start(SESSION, { text: "hello" }, { config: { model: "smart" } });
    });
    rerender({ current: { ...SESSION, status: "terminated" } });

    await act(async () => {
      await result.current.retryAfterSignIn("s-1", { text: "hello" });
    });

    const changes = spy.mock.calls.filter(([cmd]) => cmd === "acp_set_config_option").map(([, args]) => args);
    expect(changes).toEqual([{ sessionId: "s-1", configId: "model", value: "smart" }]);
  });
});
