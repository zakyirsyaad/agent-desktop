import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import type { FakeTauriStore } from "./setup";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();
const openDialog = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => openDialog(...args) }));

import App from "../App";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
type InvokeCall = [string, Record<string, unknown> | undefined, ...unknown[]];

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

const AGENT_SESSION_ID = "0b6f2a5e-3c1d-4f8e-9a7b-1c2d3e4f5a6b";

function seedSession(profileId: string, agentSessionId: string | null = null) {
  fakeStore().state.sessions = [
    {
      id: "s-src",
      name: "Parser work",
      profileId,
      cwd: "/Users/test/developer/agent-desktop",
      status: "terminated",
      createdAt: 1,
      agentSessionId,
    },
  ];
  fakeStore().transcripts["s-src"] = [
    { id: "m-1", role: "user", content: "Refactor the parser", timestamp: 1 },
    { id: "m-2", role: "agent", content: "Plan: split it in two", timestamp: 2 },
    { id: "m-3", role: "user", content: "Do it", timestamp: 3 },
    { id: "m-4", role: "agent", content: "Done, tests pass", timestamp: 4 },
  ];
}

async function renderApp() {
  await act(async () => {
    render(<App />);
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

function callsTo(spy: { mock: { calls: unknown[][] } }, cmd: string) {
  return (spy.mock.calls as InvokeCall[]).filter(([name]) => name === cmd);
}

function forkButtonFor(text: string) {
  const message = screen.getByText(text).closest("[data-testid^='chat-message-']") as HTMLElement;
  return within(message).getByRole("button", { name: "Fork branch" });
}

describe("Chat wiring", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    listeners.clear();
    openDialog.mockReset();
  });

  it("labels replies with the agent that produced them", async () => {
    seedSession("omp");
    await renderApp();

    expect((await screen.findAllByText("Oh-My-Pi")).length).toBeGreaterThan(1);
  });

  it("forks a non-native agent through a handoff file and sends the one-line prompt once the agent is idle", async () => {
    seedSession("omp");
    const spy = vi.spyOn(tauriInternals(), "invoke");
    await renderApp();
    await screen.findByText("Plan: split it in two");

    await click(forkButtonFor("Plan: split it in two"));

    const [, handoffArgs] = callsTo(spy, "write_fork_handoff")[0];
    expect(handoffArgs?.content).toContain("Plan: split it in two");
    expect(handoffArgs?.content).not.toContain("Done, tests pass");
    const [, spawnArgs] = callsTo(spy, "spawn_session")[0];
    expect(spawnArgs).toMatchObject({ profileId: "omp", cwd: "/Users/test/developer/agent-desktop" });
    expect(within(screen.getByRole("complementary")).getByText("Parser work (fork)")).toBeDefined();
    // The fork starts from the conversation up to the chosen message.
    expect(screen.queryByText("Done, tests pass")).toBeNull();

    vi.useFakeTimers();
    await act(async () => {
      listeners.get("pty-output")?.({ payload: { session_id: spawnArgs?.sessionId, data: "omp ready\n" } });
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    const prompt = callsTo(spy, "send_input").find(([, args]) => args?.sessionId === spawnArgs?.sessionId);
    expect(String(prompt?.[1]?.data)).toContain(`/fake/app-data/handoffs/${spawnArgs?.sessionId}.md`);
    expect(String(prompt?.[1]?.data).trimEnd()).not.toContain("\n");
  });

  it("forks Claude Code natively from its latest message", async () => {
    seedSession("claude-code", AGENT_SESSION_ID);
    const spy = vi.spyOn(tauriInternals(), "invoke");
    await renderApp();
    await screen.findByText("Done, tests pass");

    await click(forkButtonFor("Done, tests pass"));

    expect(callsTo(spy, "write_fork_handoff")).toHaveLength(0);
    const [, spawnArgs] = callsTo(spy, "spawn_session")[0];
    expect(spawnArgs?.options).toMatchObject({ forkFromAgentSessionId: AGENT_SESSION_ID });
  });

  it("inserts files picked with Attach into the prompt", async () => {
    openDialog.mockResolvedValue(["/Users/test/developer/agent-desktop/src/App.tsx"]);
    await renderApp();
    await click(screen.getByRole("button", { name: "+ New session" }));

    await click(screen.getByRole("button", { name: "Add attachment" }));

    const prompt = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
    expect(prompt.value).toContain("/Users/test/developer/agent-desktop/src/App.tsx");
  });

  it("marks a terminal session as working only while the agent is producing output", async () => {
    await renderApp();
    const spy = vi.spyOn(tauriInternals(), "invoke");
    await click(screen.getByRole("button", { name: "+ New session" }));
    const [, spawnArgs] = callsTo(spy, "spawn_session")[0];
    const sidebar = within(screen.getByRole("complementary"));
    expect(sidebar.queryByLabelText("Agent working")).toBeNull();

    await act(async () => {
      listeners.get("pty-output")?.({ payload: { session_id: spawnArgs?.sessionId, data: "working...\n" } });
    });

    expect(sidebar.getByLabelText("Agent working")).toBeDefined();
  });
});
