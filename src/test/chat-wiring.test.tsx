import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
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

function seedSession(profileId: string, agentSessionId: string | null = null) {
  fakeStore().state.sessions = [
    {
      id: "s-src",
      name: "Parser work",
      profileId,
      cwd: "/Users/test/developer/zorvo",
      status: "terminated",
      createdAt: 1,
      transport: "acp",
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
    seedSession("claude-acp");
    await renderApp();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(1);
  });

  it("forks an ended session through a handoff file and sends the new agent a one-line prompt", async () => {
    seedSession("claude-acp");
    const spy = vi.spyOn(tauriInternals(), "invoke");
    await renderApp();
    await screen.findByText("Plan: split it in two");

    await click(forkButtonFor("Plan: split it in two"));

    const [, handoffArgs] = callsTo(spy, "write_fork_handoff")[0];
    expect(handoffArgs?.content).toContain("Plan: split it in two");
    expect(handoffArgs?.content).not.toContain("Done, tests pass");
    const [, startArgs] = callsTo(spy, "acp_start_session")[0];
    expect(startArgs).toMatchObject({ profileId: "claude-acp", cwd: "/Users/test/developer/zorvo" });
    expect(within(screen.getByRole("complementary")).getByText("Parser work (fork)")).toBeDefined();
    // The fork starts from the conversation up to the chosen message.
    expect(screen.queryByText("Done, tests pass")).toBeNull();

    await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(1));
    const [, promptArgs] = callsTo(spy, "acp_prompt")[0];
    expect(promptArgs?.sessionId).toBe(startArgs?.sessionId);
    // The handoff path goes to the agent as hidden context, not as the fork's first message.
    expect(String(promptArgs?.text)).toContain(`/fake/app-data/handoffs/${startArgs?.sessionId}.md`);
    expect(String(promptArgs?.text)).toContain("wait for my next message");
    expect(screen.getByText("Pick up from the previous session.")).toBeDefined();
    expect(screen.queryByText(/Read the file/)).toBeNull();
  });

  it("attaches files picked with Attach to the message", async () => {
    openDialog.mockResolvedValue(["/Users/test/developer/zorvo/src/App.tsx"]);
    await renderApp();
    await click(screen.getByRole("button", { name: "+ New session" }));

    await click(screen.getByRole("button", { name: "Add attachment" }));

    const attachments = within(screen.getByRole("list", { name: "Attachments" }));
    expect(attachments.getByRole("listitem").getAttribute("title")).toBe("/Users/test/developer/zorvo/src/App.tsx");
  });
});
