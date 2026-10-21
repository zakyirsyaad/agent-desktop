import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { FakeTauriStore } from "./setup";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
  emit: () => Promise.resolve(),
}));

import App from "../App";
import { useAcpEngine } from "../hooks/session-engine/useAcpEngine";
import { useSessionImport } from "../hooks/useSessionImport";
import { NO_CHOICES } from "../lib/acp-draft";
import { newSessionRecord } from "../lib/session-start";
import { fakeProfiles } from "./fixtures/agents";
import type { AgentProfile, ChatMessage, Session } from "../types";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
type InvokeCall = [string, Record<string, unknown> | undefined, ...unknown[]];
type Spy = { mock: { calls: unknown[][] } };
type Overrides = Record<string, (args?: Record<string, unknown>) => Promise<unknown>>;

const tauriInternals = () => (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
const fakeStore = () => (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;

function callsTo(spy: Spy, cmd: string) {
  return (spy.mock.calls as unknown as InvokeCall[]).filter(([name]) => name === cmd);
}

const sidebar = () => within(screen.getByRole("complementary"));

async function acpEvent(payload: Record<string, unknown>) {
  await act(async () => {
    listeners.get("acp-event")?.({ payload });
  });
}

/** Writes what the app still has pending, state and transcripts, as closing the window does. */
async function flushSaves() {
  await act(async () => {
    window.dispatchEvent(new Event("pagehide"));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Replaces the fake invoke for some commands and passes the rest to the test double from setup.ts. */
function stubInvoke(overrides: Overrides) {
  const internals = tauriInternals();
  const original = internals.invoke;
  return vi.spyOn(internals, "invoke").mockImplementation((cmd, args) => {
    const override = overrides[cmd];
    return override ? override(args) : original(cmd, args);
  });
}

const MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
};

const MODEL_OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "fast",
    options: [
      { value: "fast", name: "Fast" },
      { value: "smart", name: "Smart" },
    ],
  },
];

const LISTED = [
  { acpSessionId: "listed-1", title: "Fix the login", updatedAt: "2026-10-20T08:00:00Z" },
  { acpSessionId: "listed-2", title: "Earlier work", updatedAt: "2026-10-19T08:00:00Z" },
];

function probeAnswer(canListSessions = true) {
  return {
    modes: MODES,
    configOptions: MODEL_OPTIONS,
    commands: [],
    signInChecked: true,
    canListSessions,
  };
}

function importAnswer(overrides: Record<string, unknown> = {}) {
  return {
    acpSessionId: "listed-1",
    agentCapabilities: { sessionCapabilities: {} },
    modes: MODES,
    models: null,
    configOptions: MODEL_OPTIONS,
    reopenedWith: "load",
    ...overrides,
  };
}

interface DraftOptions {
  canListSessions?: boolean;
  listed?: unknown;
  importSession?: (args?: Record<string, unknown>) => Promise<unknown>;
}

/** Renders the app on its new-session draft, with the fake probe and the fake agent's list. */
async function renderDraft(options: DraftOptions = {}) {
  const overrides: Overrides = {
    acp_probe_agent: () => Promise.resolve(probeAnswer(options.canListSessions ?? true)),
    acp_list_sessions: () =>
      Promise.resolve(options.listed ?? { sessions: LISTED, truncated: false, incomplete: false }),
    ...(options.importSession ? { acp_import_session: options.importSession } : {}),
  };
  const spy = stubInvoke(overrides);
  await act(async () => {
    render(<App />);
  });
  return spy;
}

/** Presses Continue and waits for the agent's list. */
async function openList() {
  const button = await screen.findByRole("button", { name: "Continue a session from Claude Code" });
  await act(async () => {
    fireEvent.click(button);
  });
  await screen.findByRole("button", { name: /Fix the login/ });
}

async function clickRow(title = "Fix the login") {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(title) }));
  });
}

describe("Importing a session the agent listed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
  });

  it("offers the list when the draft's agent can list its sessions", async () => {
    await renderDraft();

    expect(await screen.findByRole("button", { name: "Continue a session from Claude Code" })).toBeDefined();
  });

  it("shows no list when the draft's agent cannot list its sessions", async () => {
    const spy = await renderDraft({ canListSessions: false });

    await waitFor(() => expect(callsTo(spy, "acp_probe_agent")).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Continue a session from/ })).toBeNull();
  });

  it("hides the list while the draft makes a new worktree", async () => {
    await renderDraft();
    await screen.findByRole("button", { name: "Continue a session from Claude Code" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Folder: ai-perpetual-trading" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("switch", { name: "Worktree" }));
    });

    expect(screen.queryByRole("button", { name: /Continue a session from/ })).toBeNull();
  });

  it("imports a listed session with its replay and the model picked in the draft", async () => {
    let importedId = "";
    const spy = await renderDraft({
      importSession: (args) => {
        importedId = String(args?.sessionId);
        const replay = (update: Record<string, unknown>) =>
          listeners.get("acp-event")?.({ payload: { sessionId: importedId, kind: "update", update } });
        replay({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "earlier question" },
          messageId: "replay-1",
        });
        replay({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "replayed history" },
        });
        return Promise.resolve(importAnswer({ acpSessionId: args?.acpSessionId }));
      },
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Model: Fast" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Smart" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Permission mode: Default" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Plan" }));
    });
    await openList();
    await clickRow();

    await waitFor(() => expect(callsTo(spy, "acp_import_session")).toHaveLength(1));
    expect(await screen.findByText("earlier question")).toBeDefined();
    expect(screen.getByText("replayed history")).toBeDefined();
    expect(sidebar().getByText("Fix the login")).toBeDefined();
    await waitFor(() =>
      expect(callsTo(spy, "acp_set_config_option").map(([, args]) => args)).toContainEqual({
        sessionId: importedId,
        configId: "model",
        value: "smart",
      }),
    );
    // Both picks went with the import: the mode is applied and the composer shows it.
    await waitFor(() =>
      expect(callsTo(spy, "acp_set_mode").map(([, args]) => args)).toContainEqual({
        sessionId: importedId,
        modeId: "plan",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Permission mode: Plan" })).toBeDefined(),
    );
  });

  it("keeps the draft's model and mode picks when the import fails", async () => {
    await renderDraft({
      importSession: () => Promise.reject("session/load failed: Unknown session"),
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Model: Fast" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Smart" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Permission mode: Default" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Plan" }));
    });
    await openList();
    await clickRow();

    expect(await screen.findByText("Could not open the session: session/load failed: Unknown session")).toBeDefined();

    // The draft is back as it was: both picks made for the import are still selected.
    expect(screen.getByRole("heading", { name: "New session" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Model: Smart" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Permission mode: Plan" })).toBeDefined();
  });

  it("undoes the import, returns to the draft and shows the agent's error when the session is gone", async () => {
    const spy = await renderDraft({
      importSession: () => Promise.reject("session/load failed: Unknown session"),
    });
    await openList();
    await clickRow();

    expect(await screen.findByText("Could not open the session: session/load failed: Unknown session")).toBeDefined();
    await flushSaves();

    expect(screen.getByRole("heading", { name: "New session" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Folder: ai-perpetual-trading" })).toBeDefined();
    expect(sidebar().queryByText("Fix the login")).toBeNull();
    const importedId = String(callsTo(spy, "acp_import_session")[0][1]?.sessionId);
    expect(fakeStore().state.sessions).toHaveLength(0);
    expect(fakeStore().transcripts[importedId]).toBeUndefined();
    expect(callsTo(spy, "delete_transcript").map(([, args]) => args)).toContainEqual({ sessionId: importedId });
    expect(callsTo(spy, "save_transcript").filter(([, args]) => args?.sessionId === importedId)).toHaveLength(0);
  });

  it("stays on the session the user opened when a slow import fails", async () => {
    const other: Session = {
      id: "s-other",
      name: "Earlier chat",
      profileId: "claude-acp",
      cwd: "/Users/test/developer/ai-perpetual-trading",
      status: "terminated",
      createdAt: 1,
      transport: "acp",
    };
    fakeStore().state.sessions = [other];
    let rejectImport: (reason: unknown) => void = () => {};
    const spy = await renderDraft({
      importSession: () =>
        new Promise((_resolve, reject) => {
          rejectImport = reject;
        }),
    });
    // The app opens the saved session; New goes back to the draft it came from.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });
    await openList();
    await clickRow();
    await waitFor(() => expect(callsTo(spy, "acp_import_session")).toHaveLength(1));
    const importedId = String(callsTo(spy, "acp_import_session")[0][1]?.sessionId);

    // The import is still loading: the user opens the session they already had.
    await act(async () => {
      fireEvent.click(sidebar().getByText("Earlier chat"));
    });

    await act(async () => {
      rejectImport("session/load failed: Unknown session");
    });
    await flushSaves();

    // The other session stays open: the failed import does not pull the draft back.
    expect(within(screen.getByRole("banner")).getByText("Earlier chat")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "New session" })).toBeNull();
    // Its record and transcript still go, and no error is raised over another session.
    expect(sidebar().queryByText("Fix the login")).toBeNull();
    expect(fakeStore().state.sessions.map((session) => (session as { id: string }).id)).toEqual(["s-other"]);
    expect(fakeStore().transcripts[importedId]).toBeUndefined();
    expect(callsTo(spy, "delete_transcript").map(([, args]) => args)).toContainEqual({ sessionId: importedId });
    expect(callsTo(spy, "save_transcript").filter(([, args]) => args?.sessionId === importedId)).toHaveLength(0);
    expect(screen.queryByText(/Could not open the session:/)).toBeNull();
  });

  it("opens the sign-in panel when the import needs a sign-in", async () => {
    const methods = [{ id: "browser", name: "Browser" }];
    await renderDraft({
      importSession: () => Promise.reject(`ACP_AUTH_REQUIRED:${JSON.stringify(methods)}`),
    });
    await openList();
    await clickRow();

    const panel = within(await screen.findByRole("region", { name: "Sign in to Claude Code" }));
    expect(panel.getByRole("button", { name: "Sign in with Browser" })).toBeDefined();
    expect(screen.queryByText(/Could not open the session:/)).toBeNull();
  });

  it("says the earlier messages stay in the agent when the import resumes without a replay", async () => {
    await renderDraft({
      importSession: (args) =>
        Promise.resolve(importAnswer({ acpSessionId: args?.acpSessionId, reopenedWith: "resume" })),
    });
    await openList();
    await clickRow();

    expect(
      await screen.findByText("Earlier messages stay in Claude Code. They are not shown here."),
    ).toBeDefined();
  });

  it("writes no transcript for an imported session deleted while its replay still streams", async () => {
    let importedId = "";
    let finishImport: (value: unknown) => void = () => {};
    const spy = await renderDraft({
      importSession: (args) => {
        importedId = String(args?.sessionId);
        return new Promise((resolve) => {
          finishImport = resolve;
        });
      },
    });
    await openList();
    await clickRow();

    // Stop ends the open; the session is no longer starting, so its row can be deleted.
    const row = sidebar().getByText("Fix the login").closest("li") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Stop session" }));
    });
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Delete session" }));
    });
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Confirm delete" }));
    });

    // A replay update for the deleted session must not land anywhere.
    await acpEvent({
      sessionId: importedId,
      kind: "update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late history" } },
    });
    await act(async () => {
      finishImport(importAnswer());
    });
    await flushSaves();

    expect(screen.queryByText("late history")).toBeNull();
    expect(sidebar().queryByText("Fix the login")).toBeNull();
    expect(fakeStore().transcripts[importedId]).toBeUndefined();
    expect(callsTo(spy, "save_transcript").filter(([, args]) => args?.sessionId === importedId)).toHaveLength(0);
  });

  it("closes the last reply and keeps the history note of a stopped import that is kept", async () => {
    let importedId = "";
    let finishImport: (value: unknown) => void = () => {};
    await renderDraft({
      importSession: (args) => {
        importedId = String(args?.sessionId);
        listeners.get("acp-event")?.({ payload: { sessionId: importedId, kind: "update", update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "replayed history" },
        } } });
        return new Promise((resolve) => {
          finishImport = resolve;
        });
      },
    });
    await openList();
    await clickRow();
    await screen.findByText("replayed history");

    // Stop while the import is pending: the record stays, and the import answers afterwards.
    const row = sidebar().getByText("Fix the login").closest("li") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Stop session" }));
    });
    await act(async () => {
      finishImport(importAnswer({ reopenedWith: "resume" }));
    });

    expect(
      await screen.findByText("Earlier messages stay in Claude Code. They are not shown here."),
    ).toBeDefined();
    expect(sidebar().getByText("Fix the login")).toBeDefined();
    await flushSaves();

    const saved = fakeStore().transcripts[importedId] as { role: string; isComplete?: boolean }[];
    expect(saved.at(-1)?.role).toBe("agent");
    expect(saved.at(-1)?.isComplete).toBe(true);
  });
});

describe("Importing a session a Zorvo session already holds", () => {
  const HELD: Session = {
    id: "s-held",
    name: "Held",
    profileId: "claude-acp",
    cwd: "/Users/test/developer/ai-perpetual-trading",
    status: "running",
    createdAt: 1,
    acpSessionId: "listed-1",
  };
  const CLAUDE = { id: "claude-acp", name: "Claude Code" } as AgentProfile;

  it("opens the session it already holds instead of importing the id again", () => {
    const openSession = vi.fn();
    const recordSession = vi.fn();
    const importSession = vi.fn();
    const { result } = renderHook(() =>
      useSessionImport({
        sessions: [HELD],
        agent: CLAUDE,
        cwd: HELD.cwd,
        activeSessionId: HELD.id,
        acp: { importSession },
        choices: NO_CHOICES,
        onChoicesUsed: vi.fn(),
        recordSession,
        openSession,
        discardSession: vi.fn(),
        openNewSession: vi.fn(),
        requestSignIn: vi.fn(),
        onImportError: vi.fn(),
      }),
    );

    act(() => result.current({ acpSessionId: "listed-1", title: "Fix the login" }));

    expect(openSession).toHaveBeenCalledWith("s-held");
    expect(recordSession).not.toHaveBeenCalled();
    expect(importSession).not.toHaveBeenCalled();
  });
});

describe("Importing a record with no agent session id", () => {
  const CLAUDE = { id: "claude-acp", name: "Claude Code" } as AgentProfile;
  const LISTED = { acpSessionId: "listed-1", title: "Fix the login" };
  const CWD = "/Users/test/developer/ai-perpetual-trading";

  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
  });

  it("refuses before asking the agent and leaves no record or transcript behind", async () => {
    const spy = stubInvoke({});
    const onImportError = vi.fn();
    const onChoicesUsed = vi.fn();
    let sessions: Session[] = [];
    let recordedId = "";

    const { result } = renderHook(() => {
      const engine = useAcpEngine({
        sessions,
        agents: fakeProfiles,
        updateMessages: vi.fn(),
        patchSession: vi.fn(),
        reportError: vi.fn(),
        rememberOptions: vi.fn(),
        onAuthRequired: vi.fn(),
      });
      return useSessionImport({
        sessions,
        agent: CLAUDE,
        cwd: CWD,
        activeSessionId: "",
        acp: engine,
        choices: NO_CHOICES,
        onChoicesUsed,
        recordSession: (spec) => {
          // The app's own helper, with the agent's id lost on the way.
          const session = newSessionRecord({ ...spec, acpSessionId: undefined });
          recordedId = session.id;
          sessions = [session, ...sessions];
          return session;
        },
        openSession: vi.fn(),
        discardSession: (sessionId) => {
          sessions = sessions.filter((session) => session.id !== sessionId);
        },
        openNewSession: vi.fn(),
        requestSignIn: vi.fn(),
        onImportError,
      });
    });

    await act(async () => {
      result.current(LISTED);
    });

    // The backend was never asked to load an empty id, so no agent was launched.
    expect(callsTo(spy, "acp_import_session")).toHaveLength(0);
    expect(onImportError).toHaveBeenCalledWith("Could not open the session: This session has no agent session id.");
    // The record made for the import was taken back, with nothing written for it.
    expect(sessions).toHaveLength(0);
    expect(recordedId).not.toBe("");
    expect(callsTo(spy, "save_transcript").filter(([, args]) => args?.sessionId === recordedId)).toHaveLength(0);
    expect(fakeStore().transcripts[recordedId]).toBeUndefined();
    expect(onChoicesUsed).not.toHaveBeenCalled();
  });
});

describe("The draft's picks", () => {
  const CLAUDE = { id: "claude-acp", name: "Claude Code" } as AgentProfile;
  const IMPORTED: Session = {
    id: "s-import",
    name: "Fix the login",
    profileId: "claude-acp",
    cwd: "/Users/test/developer/ai-perpetual-trading",
    status: "running",
    createdAt: 1,
    acpSessionId: "listed-1",
  };
  const LISTED = { acpSessionId: "listed-1", title: "Fix the login" };

  function renderPickImport(importSession: () => Promise<boolean>) {
    const onChoicesUsed = vi.fn();
    const recordSession = vi.fn(() => IMPORTED);
    const { result } = renderHook(() =>
      useSessionImport({
        sessions: [],
        agent: CLAUDE,
        cwd: IMPORTED.cwd,
        activeSessionId: "",
        acp: { importSession },
        choices: { modeId: "plan", config: { model: "smart" } },
        onChoicesUsed,
        recordSession,
        openSession: vi.fn(),
        discardSession: vi.fn(),
        openNewSession: vi.fn(),
        requestSignIn: vi.fn(),
        onImportError: vi.fn(),
      }),
    );
    return { result, onChoicesUsed, recordSession, importSession };
  }

  it("leave the picks alone when the import does not open", async () => {
    const importSession = vi.fn(() => Promise.resolve(false));
    const { result, onChoicesUsed } = renderPickImport(importSession);

    await act(async () => {
      result.current(LISTED);
    });

    expect(importSession).toHaveBeenCalledTimes(1);
    expect(onChoicesUsed).not.toHaveBeenCalled();
  });

  it("consume the picks once the import opens", async () => {
    const importSession = vi.fn(() => Promise.resolve(true));
    const { result, onChoicesUsed } = renderPickImport(importSession);

    await act(async () => {
      result.current(LISTED);
    });

    expect(importSession).toHaveBeenCalledTimes(1);
    expect(onChoicesUsed).toHaveBeenCalledTimes(1);
  });
});

describe("Stopping an import before it answers", () => {
  const IMPORTED: Session = {
    id: "s-importing",
    name: "Fix the login",
    profileId: "claude-acp",
    cwd: "/Users/test/developer/ai-perpetual-trading",
    status: "running",
    createdAt: 1,
    acpSessionId: "listed-1",
  };

  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
  });

  it("ignores a stopped import that settles after the session is resumed", async () => {
    const internals = tauriInternals();
    const original = internals.invoke;
    let finishImport: (value: unknown) => void = () => {};
    vi.spyOn(internals, "invoke").mockImplementation((cmd, args) => {
      if (cmd === "acp_import_session") {
        return new Promise((resolve) => {
          finishImport = resolve;
        });
      }
      return original(cmd, args);
    });

    const messages = new Map<string, ChatMessage[]>([
      [IMPORTED.id, [{ id: "m-live", role: "agent", content: "live reply", timestamp: 1 }]],
    ]);
    const updateMessages = (sessionId: string, change: (prev: ChatMessage[]) => ChatMessage[]) => {
      messages.set(sessionId, change(messages.get(sessionId) ?? []));
    };
    const patches: { sessionId: string; patch: Partial<Session> }[] = [];
    const { result } = renderHook(() =>
      useAcpEngine({
        sessions: [IMPORTED],
        agents: fakeProfiles,
        updateMessages,
        patchSession: (sessionId, patch) => patches.push({ sessionId, patch }),
        reportError: () => {},
        rememberOptions: () => {},
        onAuthRequired: () => {},
      }),
    );

    let opened: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      opened = result.current.importSession(IMPORTED, NO_CHOICES, () => {});
    });
    await act(async () => {
      await result.current.stop(IMPORTED.id);
    });
    // The import is still pending; the user resumes the session that was stopped.
    await act(async () => {
      await result.current.resume(IMPORTED, "listed-1");
    });
    // A user chunk is replay-only: folded normally, it opens no user turn.
    await act(async () => {
      listeners.get("acp-event")?.({ payload: { sessionId: IMPORTED.id, kind: "update", update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "late note" },
        messageId: "late-1",
      } } });
    });

    expect(messages.get(IMPORTED.id)).toHaveLength(1);

    // The old import answers along with the resumed session's live turn.
    await act(async () => {
      finishImport(importAnswer({ reopenedWith: "resume" }));
      await opened;
    });

    // The stale import neither marks the session's history as elsewhere nor closes its live reply.
    expect(patches.some(({ sessionId, patch }) => sessionId === IMPORTED.id && patch.historyElsewhere)).toBe(false);
    expect(messages.get(IMPORTED.id)?.at(-1)?.isComplete).not.toBe(true);
  });
});

describe("Stopping a launch before its open answers", () => {
  const STARTING: Session = {
    id: "s-starting",
    name: "Fix the login",
    profileId: "claude-acp",
    cwd: "/Users/test/developer/ai-perpetual-trading",
    status: "running",
    createdAt: 1,
    acpSessionId: "listed-1",
  };

  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
  });

  it("takes back the first message of a launch a resume superseded", async () => {
    const internals = tauriInternals();
    const original = internals.invoke;
    let finishStart: (value: unknown) => void = () => {};
    vi.spyOn(internals, "invoke").mockImplementation((cmd, args) => {
      if (cmd === "acp_start_session") {
        return new Promise((resolve) => {
          finishStart = resolve;
        });
      }
      return original(cmd, args);
    });

    const messages = new Map<string, ChatMessage[]>();
    const updateMessages = (sessionId: string, change: (prev: ChatMessage[]) => ChatMessage[]) => {
      messages.set(sessionId, change(messages.get(sessionId) ?? []));
    };
    const { result } = renderHook(() =>
      useAcpEngine({
        sessions: [STARTING],
        agents: fakeProfiles,
        updateMessages,
        patchSession: () => {},
        reportError: () => {},
        rememberOptions: () => {},
        onAuthRequired: () => {},
      }),
    );

    let started: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      started = result.current.start(STARTING, { text: "never prompted" });
    });
    expect(messages.get(STARTING.id)?.map((message) => message.content)).toEqual(["never prompted"]);

    // Stop ends the start, then the user resumes the same session before the open answers.
    await act(async () => {
      await result.current.stop(STARTING.id);
    });
    await act(async () => {
      await result.current.resume(STARTING, "listed-1");
    });

    await act(async () => {
      finishStart(importAnswer());
      await started;
    });

    // The superseded launch's message was never prompted: the resumed session stays empty.
    expect(messages.get(STARTING.id)).toEqual([]);
  });
});