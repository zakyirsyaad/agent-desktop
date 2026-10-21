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
import { useSessionImport } from "../hooks/useSessionImport";
import { NO_CHOICES } from "../lib/acp-draft";
import type { AgentProfile, Session } from "../types";

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
  availableModes: [{ id: "default", name: "Default" }],
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