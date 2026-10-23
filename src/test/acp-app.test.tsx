import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, within, waitFor } from "@testing-library/react";
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

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
type InvokeCall = [string, Record<string, unknown> | undefined, ...unknown[]];

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

function callsTo(spy: { mock: { calls: unknown[][] } }, cmd: string) {
  return (spy.mock.calls as unknown as InvokeCall[]).filter(([name]) => name === cmd);
}

async function acpEvent(payload: Record<string, unknown>) {
  await act(async () => {
    listeners.get("acp-event")?.({ payload });
    // Stream updates apply once a frame; let that frame land inside act.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The fake backend itself, for mocks that change one command and pass the rest through. */
let realInvoke: TauriInternals["invoke"] = () => Promise.resolve();

async function renderWithQwen() {
  fakeStore().state.settings.defaultAgentId = "qwen";
  realInvoke = tauriInternals().invoke;
  const spy = vi.spyOn(tauriInternals(), "invoke");
  await act(async () => {
    render(<App />);
  });
  return spy;
}

function prompt(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
}

async function send(text: string) {
  await act(async () => {
    fireEvent.change(prompt(), { target: { value: text } });
    fireEvent.keyDown(prompt(), { key: "Enter" });
  });
}

/** The message `startQwenSession` starts a session with. */
const FIRST_MESSAGE = "get started";

/**
 * Starts a session the way the user does, New and then a first message, and
 * ends that first turn, so the session waits for the test's own messages.
 */
async function startQwenSession(spy: { mock: { calls: unknown[][] } }) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
  });
  await send(FIRST_MESSAGE);
  await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(1));
  const sessionId = String(callsTo(spy, "acp_start_session")[0][1]?.sessionId);
  await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });
  return sessionId;
}

describe("ACP sessions in the app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
  });

  it("starts an ACP agent by profile and switches a risky starting mode to the safe one", async () => {
    const spy = await renderWithQwen();

    const sessionId = await startQwenSession(spy);

    const [, startArgs] = callsTo(spy, "acp_start_session")[0];
    expect(startArgs).toMatchObject({ profileId: "qwen-code", cwd: "/Users/test/developer/ai-perpetual-trading" });
    // The fake agent reports "yolo" as its current mode.
    await waitFor(() =>
      expect(callsTo(spy, "acp_set_mode").map(([, a]) => a)).toContainEqual({ sessionId, modeId: "default" })
    );
  });

  it("starts a session when the user sends a message without one, and sends it as the first prompt", async () => {
    const spy = await renderWithQwen();

    await send("explain the parser");

    await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(1));
    const [, promptArgs] = callsTo(spy, "acp_prompt")[0];
    expect(promptArgs).toMatchObject({ text: "explain the parser" });
    expect(within(screen.getByTestId("chat-canvas-container")).getByText("explain the parser")).toBeDefined();
  });

  it("streams the agent's reply and ends the turn", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("hi");
    expect(screen.getByTestId("agent-working")).toBeDefined();

    await acpEvent({
      sessionId,
      kind: "update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello from Qwen" } },
    });
    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });

    expect(screen.getByText("Hello from Qwen")).toBeDefined();
    expect(screen.queryByTestId("agent-working")).toBeNull();
  });

  it("applies a streamed chunk before the turn end that closes it", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("hi");

    // No yield between the two events: the chunk is still queued when the
    // turn end flushes the queue, which is the production ordering path.
    await act(async () => {
      listeners.get("acp-event")?.({
        payload: {
          sessionId,
          kind: "update",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "One frame" } },
        },
      });
      listeners.get("acp-event")?.({ payload: { sessionId, kind: "turn-end", stopReason: "end_turn" } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByText("One frame")).toBeDefined();
    expect(screen.queryByTestId("agent-working")).toBeNull();
    // The turn ended with the chunk in it: the reply now offers its actions.
    const reply = screen.getByText("One frame").closest('[data-testid^="chat-message-"]') as HTMLElement;
    expect(within(reply).getByRole("button", { name: "Copy message" })).toBeDefined();
  });

  it("answers a permission request with the option the user picks", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("clean up");

    await acpEvent({
      sessionId,
      kind: "permission",
      requestId: "perm-7",
      toolCall: { title: "Run rm -rf build", kind: "execute" },
      options: [
        { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
        { optionId: "cancel", name: "Reject", kind: "reject_once" },
      ],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    });

    expect(callsTo(spy, "acp_respond_permission").map(([, a]) => a)).toContainEqual({
      sessionId,
      requestId: "perm-7",
      optionId: "proceed_once",
    });
    expect(screen.getByText(/You chose: Allow/)).toBeDefined();
  });

  it("stops the agent's turn from the composer while it works", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("long task");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    });

    expect(callsTo(spy, "acp_cancel").map(([, a]) => a)).toContainEqual({ sessionId });
  });

  it("shows the agent's real modes and changes them live", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await waitFor(() => expect(callsTo(spy, "acp_set_mode")).toHaveLength(1));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /permission mode: default/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "YOLO" }));
    });

    expect(callsTo(spy, "acp_set_mode").map(([, a]) => a)).toContainEqual({ sessionId, modeId: "yolo" });
  });

  it("sends a mode change at once and says a waiting request was asked before it", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("clean up");
    await acpEvent({
      sessionId,
      kind: "permission",
      requestId: "perm-8",
      toolCall: { title: "Run rm -rf build", kind: "execute" },
      options: [
        { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
        { optionId: "cancel", name: "Reject", kind: "reject_once" },
      ],
    });
    expect(screen.getByText("Run rm -rf build")).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /permission mode: default/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "YOLO" }));
    });

    expect(callsTo(spy, "acp_set_mode").map(([, a]) => a)).toContainEqual({ sessionId, modeId: "yolo" });
    expect(await screen.findByText(/before the switch/)).toBeDefined();
  });

  it("marks the session ended when the agent exits", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);

    await acpEvent({ sessionId, kind: "exit", code: 1 });

    const sidebar = within(screen.getByRole("complementary"));
    const row = sidebar.getByText(FIRST_MESSAGE).closest("li") as HTMLElement;
    expect(within(row).getByRole("button", { name: "Delete session" })).toBeDefined();
  });

  it("only marks a session as working while its agent is busy", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    const row = () => within(screen.getByRole("list", { name: /^Sessions in/ })).getAllByRole("listitem")[0];
    expect(within(row()).queryByLabelText("Agent working")).toBeNull();

    await send("go");
    expect(within(row()).getByLabelText("Agent working")).toBeDefined();

    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });
    expect(within(row()).queryByLabelText("Agent working")).toBeNull();
  });

  it("reports a failed turn instead of hiding it", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("hi");

    await acpEvent({ sessionId, kind: "turn-end", error: "model overloaded" });

    expect(screen.getByRole("alert").textContent).toContain("model overloaded");
    expect(screen.queryByTestId("agent-working")).toBeNull();
  });

  it("forks a live ACP session natively from its latest reply", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("plan it");
    await acpEvent({
      sessionId,
      kind: "update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Here is the plan" } },
    });
    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });

    const reply = screen.getByText("Here is the plan").closest("[data-testid^='chat-message-']") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(reply).getByRole("button", { name: "Fork branch" }));
    });

    const [, forkArgs] = callsTo(spy, "acp_fork_session")[0];
    expect(forkArgs).toMatchObject({ sourceSessionId: sessionId, cwd: "/Users/test/developer/ai-perpetual-trading" });
    expect(callsTo(spy, "write_fork_handoff")).toHaveLength(0);
    expect(within(screen.getByRole("complementary")).getByText(`${FIRST_MESSAGE} (fork)`)).toBeDefined();
  });

  it("stops a live ACP agent when its session is deleted and ignores its late events", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    const row = within(screen.getByRole("complementary")).getByText(FIRST_MESSAGE).closest("li") as HTMLElement;

    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Delete session" }));
    });
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Confirm delete" }));
    });
    await acpEvent({ sessionId, kind: "exit", code: 0 });

    expect(callsTo(spy, "acp_stop_session").map(([, a]) => a)).toContainEqual({ sessionId });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(callsTo(spy, "save_transcript").filter(([, a]) => a?.sessionId === sessionId)).toHaveLength(0);
  });

  it("answers the agent's open permission requests as cancelled when the user stops the turn", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("clean up");
    await acpEvent({
      sessionId,
      kind: "permission",
      requestId: 11,
      toolCall: { title: "Delete build" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    });

    expect(callsTo(spy, "acp_respond_permission").map(([, a]) => a)).toContainEqual({
      sessionId,
      requestId: 11,
      optionId: null,
    });
    expect(callsTo(spy, "acp_cancel")).toHaveLength(1);
  });

  it("stops an agent waiting for approval from the background tasks menu through the interrupt path", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("clean up");
    await acpEvent({
      sessionId,
      kind: "permission",
      requestId: 21,
      toolCall: { title: "Delete build" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Background tasks/ }));
    });
    const list = screen.getByRole("list", { name: "Running tasks" });
    await act(async () => {
      fireEvent.click(within(list).getByRole("button", { name: /^Stop / }));
    });

    expect(callsTo(spy, "acp_respond_permission").map(([, a]) => a)).toContainEqual({
      sessionId,
      requestId: 21,
      optionId: null,
    });
    expect(callsTo(spy, "acp_cancel")).toHaveLength(1);
  });

  it("keeps the card open when answering the agent fails", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("clean up");
    await acpEvent({
      sessionId,
      kind: "permission",
      requestId: 12,
      toolCall: { title: "Delete build" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
    const original = realInvoke;
    spy.mockImplementation((cmd, args) =>
      cmd === "acp_respond_permission" ? Promise.reject("request expired") : original(cmd, args)
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    });

    expect(screen.getByRole("alert").textContent).toContain("request expired");
    expect(screen.getByRole("button", { name: "Allow" })).toBeDefined();
  });

  it("keeps a session running and sends the first prompt when the safe-mode switch fails", async () => {
    const spy = await renderWithQwen();
    const original = realInvoke;
    spy.mockImplementation((cmd, args) =>
      cmd === "acp_set_mode" ? Promise.reject("mode switch timed out") : original(cmd, args)
    );

    await send("explain the parser");

    await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(1));
    expect(screen.getByRole("alert").textContent).toContain("mode switch timed out");
    const row = within(screen.getByRole("complementary")).getByText("explain the parser").closest("li") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "Delete session" })).toBeNull();
  });

  it("stopping a session while its agent starts ends that agent once it is up", async () => {
    const spy = await renderWithQwen();
    const original = realInvoke;
    let finishStart: () => void = () => {};
    spy.mockImplementation((cmd, args) =>
      cmd === "acp_start_session"
        ? new Promise((resolve) => {
            finishStart = () => resolve(original(cmd, args));
          })
        : original(cmd, args)
    );
    await send("explain the parser");
    const [, startArgs] = callsTo(spy, "acp_start_session")[0];
    const sessionId = String(startArgs?.sessionId);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    });
    await act(async () => {
      finishStart();
    });

    // Stop ends the agent it knows; the open answer then ends the one the
    // backend registered after that stop, which only the post-open branch can do.
    await waitFor(() => expect(callsTo(spy, "acp_stop_session")).toHaveLength(2));
    expect(callsTo(spy, "acp_stop_session").map(([, a]) => a)).toEqual([{ sessionId }, { sessionId }]);
    expect(callsTo(spy, "acp_prompt")).toHaveLength(0);
    expect(callsTo(spy, "acp_set_mode")).toHaveLength(0);
  });

  it("does not send another prompt while the agent is still working", async () => {
    const spy = await renderWithQwen();
    await startQwenSession(spy);
    await send("first");

    await send("second");

    // The session's first message and "first"; "second" waits.
    expect(callsTo(spy, "acp_prompt")).toHaveLength(2);
    expect((screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement).value).toBe("second");
  });

  it("remembers the options an agent reported, for the composer before the next session", async () => {
    const spy = await renderWithQwen();
    await startQwenSession(spy);

    await waitFor(() => {
      const options = fakeStore().state.agentOptions as Record<string, { modes?: { availableModes: unknown[] } }>;
      expect(options?.["qwen-code"]?.modes?.availableModes).toHaveLength(2);
    });
  });

  it("offers the agent's last options before a session starts and applies the user's pick", async () => {
    fakeStore().state.agentOptions = {
      qwen: {
        modes: { currentModeId: "yolo", availableModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "YOLO" }] },
        configOptions: [],
      },
    };
    const spy = await renderWithQwen();
    expect(screen.getByRole("button", { name: "Permission mode: Default" })).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Permission mode: Default" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "YOLO" }));
    });
    await send("go");

    await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(1));
    // The fake agent starts in YOLO already, so nothing is switched; above all not to Default.
    expect(callsTo(spy, "acp_set_mode")).toHaveLength(0);
  });

  it("asks an agent that never ran what it offers, so its model, effort and commands show before the first message", async () => {
    realInvoke = tauriInternals().invoke;
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "acp_probe_agent"
        ? Promise.resolve({
            modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
            configOptions: [
              { id: "model", name: "Model", category: "model", type: "select", currentValue: "fast", options: [{ value: "fast", name: "Fast" }, { value: "smart", name: "Smart" }] },
              { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
            ],
            commands: [{ name: "review", description: "Review the changes" }],
          })
        : realInvoke(cmd, args)
    );
    fakeStore().state.settings.defaultAgentId = "qwen";

    await act(async () => {
      render(<App />);
    });

    expect(await screen.findByRole("button", { name: "Model: Fast" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Effort: High" })).toBeDefined();
    await act(async () => {
      fireEvent.change(prompt(), { target: { value: "/" } });
    });
    expect(screen.getByText("/review")).toBeDefined();
  });

  it("asks the user to sign in as soon as a signed-out agent is picked, before any message", async () => {
    realInvoke = tauriInternals().invoke;
    const methods = [{ id: "chat-gpt", name: "ChatGPT" }];
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "acp_probe_agent" ? Promise.reject(`ACP_AUTH_REQUIRED:${JSON.stringify(methods)}`) : realInvoke(cmd, args)
    );
    fakeStore().state.settings.defaultAgentId = "qwen";

    await act(async () => {
      render(<App />);
    });

    const panel = within(await screen.findByRole("region", { name: "Sign in to Qwen Code" }));
    expect(panel.getByRole("button", { name: "Sign in with ChatGPT" })).toBeDefined();
  });

  it("asks a signed-out agent again when the user comes back to the window, and clears the panel once someone is signed in", async () => {
    realInvoke = tauriInternals().invoke;
    let signedIn = false;
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "acp_probe_agent"
        ? signedIn
          ? Promise.resolve({ modes: null, configOptions: [], commands: [], signInChecked: true })
          : Promise.reject(`ACP_AUTH_REQUIRED:${JSON.stringify([])}`)
        : realInvoke(cmd, args)
    );
    fakeStore().state.settings.defaultAgentId = "qwen";
    await act(async () => {
      render(<App />);
    });
    expect(await screen.findByRole("region", { name: "Sign in to Qwen Code" })).toBeDefined();

    // Signed in with the agent's own tool, in a terminal.
    signedIn = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(screen.queryByRole("region", { name: "Sign in to Qwen Code" })).toBeNull());
  });

  it("keeps the sign-in panel when the agent's answer could not tell whether anyone signed in", async () => {
    realInvoke = tauriInternals().invoke;
    let asked = 0;
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "acp_probe_agent"
        ? ++asked === 1
          ? Promise.reject(`ACP_AUTH_REQUIRED:${JSON.stringify([])}`)
          : Promise.resolve({ modes: null, configOptions: [], commands: [], signInChecked: false })
        : realInvoke(cmd, args)
    );
    fakeStore().state.settings.defaultAgentId = "qwen";
    await act(async () => {
      render(<App />);
    });
    expect(await screen.findByRole("region", { name: "Sign in to Qwen Code" })).toBeDefined();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(asked).toBe(2));

    expect(screen.getByRole("region", { name: "Sign in to Qwen Code" })).toBeDefined();
  });

  it("does not say the agent's options are loading once its session runs", async () => {
    realInvoke = tauriInternals().invoke;
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "acp_probe_agent" ? new Promise(() => {}) : realInvoke(cmd, args)
    );
    fakeStore().state.settings.defaultAgentId = "qwen";
    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });
    expect(await screen.findByText(/Loading Qwen Code's models and commands/)).toBeDefined();

    await send("hello");
    await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(1));

    expect(screen.queryByText(/Loading Qwen Code's models and commands/)).toBeNull();
  });

  it("continues an ended ACP session with the agent's own session/load", async () => {
    fakeStore().state.sessions = [
      {
        id: "s-old",
        name: "Session #4",
        profileId: "qwen",
        cwd: "/Users/test/developer/ai-perpetual-trading",
        status: "terminated",
        createdAt: 1,
        transport: "acp",
        acpSessionId: "qwen-old",
      },
    ];
    const spy = await renderWithQwen();
    expect(screen.getByPlaceholderText(/continue this session/i)).toBeDefined();

    await send("next step");

    await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(1));
    expect(callsTo(spy, "acp_reopen_session")[0][1]).toMatchObject({
      sessionId: "s-old",
      profileId: "qwen-code",
      cwd: "/Users/test/developer/ai-perpetual-trading",
      acpSessionId: "qwen-old",
    });
    expect(callsTo(spy, "acp_prompt")[0][1]).toMatchObject({ sessionId: "s-old", text: "next step" });
    expect(callsTo(spy, "acp_start_session")).toHaveLength(0);
    expect(within(screen.getByRole("complementary")).queryByText("Session #5")).toBeNull();
  });

  it("unarchives an archived ACP session when the user continues it", async () => {
    fakeStore().state.sessions = [
      {
        id: "s-old",
        name: "Old parser work",
        profileId: "qwen",
        cwd: "/Users/test/developer/ai-perpetual-trading",
        status: "terminated",
        createdAt: 1,
        transport: "acp",
        acpSessionId: "qwen-old",
        archivedAt: 5,
      },
    ];
    const spy = await renderWithQwen();
    const sidebar = within(screen.getByRole("complementary"));
    await act(async () => {
      fireEvent.click(sidebar.getByRole("button", { name: "Archived (1)" }));
    });
    await act(async () => {
      fireEvent.click(sidebar.getByText("Old parser work"));
    });

    await send("next step");

    await waitFor(() => expect(callsTo(spy, "acp_reopen_session")).toHaveLength(1));
    expect(within(sidebar.getByRole("list", { name: /^Sessions in/ })).getByText("Old parser work")).toBeDefined();
    expect(sidebar.queryByRole("button", { name: /^Archived/ })).toBeNull();
  });

  it("offers no Archive while the agent waits for a permission answer", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("clean up");
    await acpEvent({
      sessionId,
      kind: "permission",
      requestId: "perm-9",
      toolCall: { title: "Run rm -rf build", kind: "execute" },
      options: [
        { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
        { optionId: "cancel", name: "Reject", kind: "reject_once" },
      ],
    });
    const row = within(screen.getByRole("complementary")).getByText(FIRST_MESSAGE).closest("li") as HTMLElement;

    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: `More actions for ${FIRST_MESSAGE}` }));
    });

    // Its open request would outlive a stopped agent: Stop (which closes it) comes first.
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
    expect(screen.getByRole("button", { name: "Allow" })).toBeDefined();
  });

  it("reports a session that cannot be resumed and leaves it ended", async () => {
    fakeStore().state.sessions = [
      {
        id: "s-old",
        name: "Session #4",
        profileId: "qwen",
        cwd: "/Users/test/developer/ai-perpetual-trading",
        status: "terminated",
        createdAt: 1,
        transport: "acp",
        acpSessionId: "qwen-old",
      },
    ];
    const spy = await renderWithQwen();
    spy.mockImplementation((cmd, args) =>
      cmd === "acp_reopen_session" ? Promise.reject("session not found") : realInvoke(cmd, args)
    );

    await send("next step");

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("session not found"));
    expect(callsTo(spy, "acp_prompt")).toHaveLength(0);
    expect(screen.getByPlaceholderText(/continue this session/i)).toBeDefined();
  });

  it("offers the agent's slash commands in the composer and remembers them for the next session", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);

    await acpEvent({
      sessionId,
      kind: "update",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "init", description: "Create a QWEN.md" },
          { name: "compress", description: "Compress the context", input: { hint: "optional focus" } },
        ],
      },
    });
    await act(async () => {
      fireEvent.change(prompt(), { target: { value: "/" } });
    });

    expect(screen.getAllByRole("option").map((o) => o.getAttribute("data-command"))).toEqual(["init", "compress"]);
    await waitFor(() => {
      const options = fakeStore().state.agentOptions as Record<string, { commands?: { name: string; hint?: string }[] }>;
      expect(options?.["qwen-code"]?.commands).toEqual([
        { name: "init", description: "Create a QWEN.md" },
        { name: "compress", description: "Compress the context", hint: "optional focus" },
      ]);
    });
  });

  it("names a session after its first message, then after the agent's own title", async () => {
    const spy = await renderWithQwen();
    await send("explain the parser");
    const sidebar = within(screen.getByRole("complementary"));
    expect(sidebar.getByText("explain the parser")).toBeDefined();
    const [, startArgs] = callsTo(spy, "acp_start_session")[0];

    await acpEvent({
      sessionId: String(startArgs?.sessionId),
      kind: "update",
      update: { sessionUpdate: "session_info_update", title: "Parser walkthrough" },
    });

    expect(sidebar.getByText("Parser walkthrough")).toBeDefined();
  });

  it("names a new session after its first message and keeps that name", async () => {
    const spy = await renderWithQwen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });
    const sidebar = within(screen.getByRole("complementary"));

    await send("first question");
    await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(1));
    await acpEvent({ sessionId: String(callsTo(spy, "acp_start_session")[0][1]?.sessionId), kind: "turn-end", stopReason: "end_turn" });
    await send("second question");

    expect(sidebar.getByText("first question")).toBeDefined();
    expect(sidebar.queryByText(/^Session #/)).toBeNull();
    expect(sidebar.queryByText("second question")).toBeNull();
  });

  it("asks the user to sign in when the agent needs it, and signs in with a method that needs no secret", async () => {
    const spy = await renderWithQwen();
    const methods = [
      { id: "api-key", name: "API Key", description: "Use an API key to authenticate", _meta: { "api-key": {} } },
      { id: "chat-gpt", name: "ChatGPT", description: "Use ChatGPT to authenticate" },
    ];
    let starts = 0;
    spy.mockImplementation((cmd, args) =>
      cmd === "acp_start_session" && starts++ === 0
        ? Promise.reject(`ACP_AUTH_REQUIRED:${JSON.stringify(methods)}`)
        : cmd === "acp_authenticate" || cmd === "acp_probe_agent"
          ? Promise.resolve(undefined)
          : realInvoke(cmd, args)
    );

    await send("hello");

    const panel = within(await screen.findByRole("region", { name: "Sign in to Qwen Code" }));
    expect(panel.getByText("Use an API key to authenticate")).toBeDefined();
    // The message waits in the composer, to be sent again after signing in.
    expect(prompt().value).toBe("hello");
    expect(panel.queryByRole("button", { name: /API Key/ })).toBeNull();
    await act(async () => {
      fireEvent.click(panel.getByRole("button", { name: "Sign in with ChatGPT" }));
    });

    expect(callsTo(spy, "acp_authenticate")[0][1]).toEqual({
      profileId: "qwen-code",
      cwd: "/Users/test/developer/ai-perpetual-trading",
      methodId: "chat-gpt",
    });
    // Signed in, the refused message goes out by itself.
    await waitFor(() => expect(callsTo(spy, "acp_start_session")).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks the user to sign in when the agent refuses a prompt for it, and keeps the message to send again", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    const methods = [{ id: "chat-gpt", name: "ChatGPT", description: "Use ChatGPT to authenticate" }];

    await send("still there?");
    await acpEvent({ sessionId, kind: "turn-end", error: `ACP_AUTH_REQUIRED:${JSON.stringify(methods)}` });

    const panel = within(await screen.findByRole("region", { name: "Sign in to Qwen Code" }));
    expect(panel.getByRole("button", { name: "Sign in with ChatGPT" })).toBeDefined();
    // Not a failed turn: the message goes back to the composer instead of staying unanswered in the chat.
    expect(screen.queryByText(/The agent's turn failed/)).toBeNull();
    expect(prompt().value).toBe("still there?");
    expect(screen.queryByText("still there?", { selector: ":not(textarea)" })).toBeNull();
  });

  it("does not put a refused message into another session's composer", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("still there?");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });
    await act(async () => {
      fireEvent.change(prompt(), { target: { value: "a new idea" } });
    });

    await acpEvent({ sessionId, kind: "turn-end", error: `ACP_AUTH_REQUIRED:${JSON.stringify([])}` });

    expect(await screen.findByRole("region", { name: "Sign in to Qwen Code" })).toBeDefined();
    expect(prompt().value).toBe("a new idea");
  });

  it("sends attached files with the message and shows them in the chat", async () => {
    const spy = await renderWithQwen();
    await startQwenSession(spy);
    spy.mockImplementation((cmd, args) =>
      cmd === "plugin:dialog|open" ? Promise.resolve(["/Users/test/shot.png"]) : realInvoke(cmd, args)
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
    });
    await send("what is wrong here?");

    expect(callsTo(spy, "acp_prompt").at(-1)?.[1]).toMatchObject({
      text: "what is wrong here?",
      attachments: ["/Users/test/shot.png"],
    });
    const chat = within(screen.getByTestId("chat-canvas-container"));
    expect(chat.getByText("shot.png")).toBeDefined();
  });

  it("keeps slash commands the agent announced before its session finished starting", async () => {
    const spy = await renderWithQwen();
    let finishStart: () => void = () => {};
    spy.mockImplementation((cmd, args) =>
      cmd === "acp_start_session"
        ? new Promise((resolve) => {
            finishStart = () => resolve(realInvoke(cmd, args));
          })
        : realInvoke(cmd, args)
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });
    await send(FIRST_MESSAGE);
    const sessionId = String(callsTo(spy, "acp_start_session")[0][1]?.sessionId);

    await acpEvent({
      sessionId,
      kind: "update",
      update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "init", description: "Set up" }] },
    });
    await act(async () => {
      finishStart();
    });
    await act(async () => {
      fireEvent.change(prompt(), { target: { value: "/" } });
    });

    expect(screen.getAllByRole("option").map((o) => o.getAttribute("data-command"))).toEqual(["init"]);
  });

  it("forks through a handoff file once the source agent has exited", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("plan it");
    await acpEvent({
      sessionId,
      kind: "update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Here is the plan" } },
    });
    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });
    await acpEvent({ sessionId, kind: "exit", code: 1 });

    const reply = screen.getByText("Here is the plan").closest("[data-testid^='chat-message-']") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(reply).getByRole("button", { name: "Fork branch" }));
    });

    await waitFor(() => expect(callsTo(spy, "write_fork_handoff")).toHaveLength(1));
    expect(callsTo(spy, "acp_fork_session")).toHaveLength(0);
  });

  /** Clicks a user message's Rewind, then confirms it. */
  async function rewindTo(text: string) {
    const yours = screen.getByText(text, { selector: "p" }).closest("[data-testid^='chat-message-']") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(yours).getByRole("button", { name: "Rewind to here" }));
    });
    await act(async () => {
      fireEvent.click(within(yours).getByRole("button", { name: "Confirm rewind" }));
    });
  }

  it("rewinds in place: the agent ends, the conversation goes back to before the message, which returns to the composer", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("plan the parser");
    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });

    await rewindTo("plan the parser");

    expect(callsTo(spy, "acp_stop_session").map(([, a]) => a)).toContainEqual({ sessionId });
    const chat = within(screen.getByTestId("chat-canvas-container"));
    expect(chat.queryByText("plan the parser")).toBeNull();
    expect(chat.getByText(FIRST_MESSAGE, { selector: "p" })).toBeDefined();
    expect(prompt().value).toBe("plan the parser");
    // Still the one session: no fork in the sidebar.
    expect(within(screen.getByRole("complementary")).queryByText(`${FIRST_MESSAGE} (fork)`)).toBeNull();
    expect(callsTo(spy, "acp_start_session")).toHaveLength(1);
  });

  it("asks before rewinding, and a first click alone changes nothing", async () => {
    const spy = await renderWithQwen();
    await startQwenSession(spy);
    const first = screen.getByText(FIRST_MESSAGE, { selector: "p" }).closest("[data-testid^='chat-message-']") as HTMLElement;

    await act(async () => {
      fireEvent.click(within(first).getByRole("button", { name: "Rewind to here" }));
    });

    expect(callsTo(spy, "acp_stop_session")).toHaveLength(0);
    expect(within(first).getByRole("button", { name: "Confirm rewind" })).toBeDefined();
  });

  it("continues a rewound session in a fresh agent, handed the conversation left but showing only the new message", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("plan the parser");
    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });
    await rewindTo("plan the parser");

    await send("plan the lexer");

    await waitFor(() => expect(callsTo(spy, "acp_start_session")).toHaveLength(2));
    // The same session, with a fresh agent.
    expect(callsTo(spy, "acp_start_session")[1][1]).toMatchObject({ sessionId });
    const handoff = String(callsTo(spy, "write_fork_handoff")[0][1]?.content);
    expect(handoff).toContain(FIRST_MESSAGE);
    expect(handoff).not.toContain("plan the parser");
    await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(3));
    const sent = String(callsTo(spy, "acp_prompt")[2][1]?.text);
    expect(sent).toContain(String(callsTo(spy, "write_fork_handoff")[0][1]?.handoffId));
    expect(sent.endsWith("plan the lexer")).toBe(true);
    const chat = within(screen.getByTestId("chat-canvas-container"));
    expect(chat.getByText("plan the lexer", { selector: "p" })).toBeDefined();
    expect(chat.queryByText(/Read the file/)).toBeNull();
  });

  it("keeps the message in the composer when the conversation cannot be handed to a fresh agent", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("plan the parser");
    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });
    await rewindTo("plan the parser");
    spy.mockImplementation((cmd, args) =>
      cmd === "write_fork_handoff" ? Promise.reject("disk full") : realInvoke(cmd, args),
    );

    await send("plan the lexer");

    expect(await screen.findByText(/Could not continue the session: disk full/)).toBeDefined();
    expect(prompt().value).toBe("plan the lexer");
    expect(callsTo(spy, "acp_start_session")).toHaveLength(1);
  });

  it("takes no second message while a rewound session's fresh agent is being handed the conversation", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("plan the parser");
    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });
    await rewindTo("plan the parser");
    let finishHandoff: (path: string) => void = () => {};
    spy.mockImplementation((cmd, args) =>
      cmd === "write_fork_handoff"
        ? new Promise((resolve) => {
            finishHandoff = resolve;
          })
        : realInvoke(cmd, args),
    );

    await send("plan the lexer");
    await send("and the tokens");

    expect(callsTo(spy, "write_fork_handoff")).toHaveLength(1);
    expect(prompt().value).toBe("and the tokens");
    await act(async () => {
      finishHandoff("/fake/app-data/handoffs/rewind.md");
    });
    await waitFor(() => expect(callsTo(spy, "acp_start_session")).toHaveLength(2));
  });

  it("starts no agent when Stop is pressed while a rewound session's restart is pending, and keeps the message", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("plan the parser");
    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });
    await rewindTo("plan the parser");
    let finishHandoff: (path: string) => void = () => {};
    spy.mockImplementation((cmd, args) =>
      cmd === "write_fork_handoff"
        ? new Promise((resolve) => {
            finishHandoff = resolve;
          })
        : realInvoke(cmd, args),
    );
    await send("plan the lexer");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    });
    // Back at once, so it is there to edit while the wait goes on.
    expect(prompt().value).toBe("plan the lexer");
    await act(async () => {
      fireEvent.change(prompt(), { target: { value: "a newer draft" } });
    });
    await act(async () => {
      finishHandoff("/fake/app-data/handoffs/rewind.md");
    });

    expect(callsTo(spy, "acp_start_session")).toHaveLength(1);
    expect(callsTo(spy, "acp_cancel")).toHaveLength(0);
    // The end of the wait leaves the draft typed meanwhile alone.
    expect(prompt().value).toBe("a newer draft");
    expect(screen.queryByRole("button", { name: "Stop agent" })).toBeNull();
  });

  it("puts an unsent message back in its own session when the handoff fails after the user moved on", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("plan the parser");
    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });
    await rewindTo("plan the parser");
    let failHandoff: (error: string) => void = () => {};
    spy.mockImplementation((cmd, args) =>
      cmd === "write_fork_handoff"
        ? new Promise((_, reject) => {
            failHandoff = reject;
          })
        : realInvoke(cmd, args),
    );
    await send("plan the lexer");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });
    await act(async () => {
      failHandoff("disk full");
    });

    expect(screen.queryByRole("heading", { name: "New session" })).toBeNull();
    expect(within(screen.getByTestId("chat-canvas-container")).getByText(FIRST_MESSAGE, { selector: "p" })).toBeDefined();
    expect(prompt().value).toBe("plan the lexer");
  });

  it("rewinds to the first message to an empty session, which starts afresh without a handoff", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);

    await rewindTo(FIRST_MESSAGE);
    expect(prompt().value).toBe(FIRST_MESSAGE);
    await send("start over");

    await waitFor(() => expect(callsTo(spy, "acp_start_session")).toHaveLength(2));
    expect(callsTo(spy, "acp_start_session")[1][1]).toMatchObject({ sessionId });
    expect(callsTo(spy, "write_fork_handoff")).toHaveLength(0);
    await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(2));
    expect(callsTo(spy, "acp_prompt")[1][1]).toMatchObject({ text: "start over" });
  });

  it("shows the session's folder and branch above its conversation", async () => {
    const spy = await renderWithQwen();
    await startQwenSession(spy);

    const workspace = within(within(screen.getByTestId("chat-canvas-container")).getByRole("group", { name: "Workspace" }));
    expect(workspace.getByText("ai-perpetual-trading")).toBeDefined();
    expect(await workspace.findByLabelText("Branch main")).toBeDefined();
  });

  it("stays busy until the first prompt is out, so a second message cannot slip in", async () => {
    const spy = await renderWithQwen();
    let finishSetMode: () => void = () => {};
    spy.mockImplementation((cmd, args) =>
      cmd === "acp_set_mode"
        ? new Promise((resolve) => {
            finishSetMode = () => resolve(realInvoke(cmd, args));
          })
        : realInvoke(cmd, args)
    );

    await send("first");
    await waitFor(() => expect(callsTo(spy, "acp_set_mode")).toHaveLength(1));
    await send("second");

    expect(callsTo(spy, "acp_prompt")).toHaveLength(0);
    expect(prompt().value).toBe("second");
    await act(async () => {
      finishSetMode();
    });
    await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(1));
    expect(callsTo(spy, "acp_prompt")[0][1]).toMatchObject({ text: "first" });
  });

  it("reads the changes again when the agent's turn ends", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("edit the parser");
    const reads = () => callsTo(spy, "session_changes").length;
    const before = reads();

    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });

    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("keeps a name the user gave when the agent later reports its own title", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    const sidebar = within(screen.getByRole("complementary"));
    const row = sidebar.getByText(FIRST_MESSAGE).closest("li") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: `More actions for ${FIRST_MESSAGE}` }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: `Rename ${FIRST_MESSAGE}` }), { target: { value: "Parser work" } });
      fireEvent.keyDown(screen.getByRole("textbox", { name: `Rename ${FIRST_MESSAGE}` }), { key: "Enter" });
    });

    await acpEvent({ sessionId, kind: "update", update: { sessionUpdate: "session_info_update", title: "Agent's summary" } });

    expect(sidebar.getByText("Parser work")).toBeDefined();
    expect(sidebar.queryByText("Agent's summary")).toBeNull();
    await waitFor(() =>
      expect(fakeStore().state.sessions.find((s) => (s as { id: string }).id === sessionId)).toMatchObject({
        name: "Parser work",
        namedByUser: true,
      })
    );
  });

  it("marks a session unread when its agent finishes while another is open, until it is opened", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("long task");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });
    const sidebar = within(screen.getByRole("complementary"));
    const row = () => sidebar.getByText(FIRST_MESSAGE).closest("li") as HTMLElement;

    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });

    expect(within(row()).getByLabelText("New activity")).toBeDefined();
    await act(async () => {
      fireEvent.click(sidebar.getByText(FIRST_MESSAGE));
    });
    expect(within(row()).queryByLabelText("New activity")).toBeNull();
  });

  it("does not mark the open session unread when its agent finishes", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("short task");

    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });

    const row = within(screen.getByRole("complementary")).getByText(FIRST_MESSAGE).closest("li") as HTMLElement;
    expect(within(row).queryByLabelText("New activity")).toBeNull();
  });

  describe("choosing Qwen's model", () => {
    // Shaped like Qwen Code's buildConfigOptions: model values carry the auth type.
    const modelOption = (currentValue: string) => ({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options: [
        { value: "coder-model(qwen-oauth)", name: "Coder Model" },
        { value: "qwen3-max(openai)", name: "Qwen3 Max" },
      ],
    });
    // As in Qwen, the efforts on offer depend on the model.
    const EFFORTS: Record<string, { value: string; name: string }[]> = {
      "coder-model(qwen-oauth)": [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
      "qwen3-max(openai)": [
        { value: "low", name: "Low" },
        { value: "max", name: "Max" },
      ],
    };
    const effortOption = (model: string, currentValue: string) => ({
      id: "reasoning_effort",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue,
      options: EFFORTS[model],
    });
    // What the fake agent holds now; every new session starts on its defaults, as Qwen's do.
    const current = { model: "coder-model(qwen-oauth)", effort: "low" };
    const reported = () => [modelOption(current.model), effortOption(current.model, current.effort)];
    function withModels() {
      return vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) => {
        const a = args as { sessionId?: string; value?: string; configId?: string } | undefined;
        if (cmd === "acp_start_session") {
          current.model = "coder-model(qwen-oauth)";
          current.effort = "low";
          return Promise.resolve({
            acpSessionId: `acp-${a?.sessionId}`,
            agentCapabilities: {},
            modes: null,
            models: null,
            configOptions: reported(),
          });
        }
        if (cmd === "acp_set_config_option") {
          const value = String(a?.value);
          if (a?.configId === "model") {
            current.model = value;
            // A model without the current effort falls back to its lowest one.
            if (!EFFORTS[value].some((e) => e.value === current.effort)) current.effort = "low";
          } else if (EFFORTS[current.model].some((e) => e.value === value)) {
            current.effort = value;
          } else {
            return Promise.reject(`Reasoning selection was not applied: ${value}`);
          }
          return Promise.resolve(reported());
        }
        return realInvoke(cmd, args);
      });
    }

    async function pick(control: string, option: string) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${control}:`) }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("option", { name: option }));
      });
    }

    /** Opens a new session, sends a message and returns the calls made from then on. */
    async function nextSessionCalls(spy: ReturnType<typeof withModels>) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
      });
      const before = (spy.mock.calls as unknown as InvokeCall[]).length;
      await send("next task");
      await waitFor(() => expect(callsTo(spy, "acp_prompt").length).toBeGreaterThan(1));
      return (spy.mock.calls as unknown as InvokeCall[])
        .slice(before)
        .map(([cmd, a]) => `${cmd}${(a as { value?: string })?.value ? `:${(a as { value?: string }).value}` : ""}`);
    }

    it("restarts a rewound session on the model it ran with, not the one picked last in another session", async () => {
      await renderWithQwen();
      const spy = withModels();
      await startQwenSession(spy);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
      });
      await send("other task");
      await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(2));
      await pick("Model", "Qwen3 Max");
      await act(async () => {
        fireEvent.click(within(screen.getByRole("complementary")).getByText(FIRST_MESSAGE));
      });
      const first = screen.getByText(FIRST_MESSAGE, { selector: "p" }).closest("[data-testid^='chat-message-']") as HTMLElement;
      await act(async () => {
        fireEvent.click(within(first).getByRole("button", { name: "Rewind to here" }));
      });
      await act(async () => {
        fireEvent.click(within(first).getByRole("button", { name: "Confirm rewind" }));
      });

      expect(screen.getByRole("button", { name: "Model: Coder Model" })).toBeDefined();
      const before = (spy.mock.calls as unknown as InvokeCall[]).length;
      await send("start over");
      await waitFor(() => expect(callsTo(spy, "acp_start_session")).toHaveLength(3));
      await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(3));

      const values = (spy.mock.calls as unknown as InvokeCall[])
        .slice(before)
        .filter(([cmd]) => cmd === "acp_set_config_option")
        .map(([, a]) => (a as { value?: string }).value);
      expect(values).not.toContain("qwen3-max(openai)");
    });

    it("restarts a rewound session on its own effort, one another session's model does not offer", async () => {
      await renderWithQwen();
      const spy = withModels();
      await startQwenSession(spy);
      await pick("Effort", "High");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
      });
      await send("other task");
      await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(2));
      // Qwen3 Max offers Low and Max: the remembered lists no longer have High.
      await pick("Model", "Qwen3 Max");
      await act(async () => {
        fireEvent.click(within(screen.getByRole("complementary")).getByText(FIRST_MESSAGE));
      });
      const first = screen.getByText(FIRST_MESSAGE, { selector: "p" }).closest("[data-testid^='chat-message-']") as HTMLElement;
      await act(async () => {
        fireEvent.click(within(first).getByRole("button", { name: "Rewind to here" }));
      });
      await act(async () => {
        fireEvent.click(within(first).getByRole("button", { name: "Confirm rewind" }));
      });

      expect(screen.getByRole("button", { name: "Model: Coder Model" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Effort: High" })).toBeDefined();
      const before = (spy.mock.calls as unknown as InvokeCall[]).length;
      await send("start over");
      await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(3));

      const values = (spy.mock.calls as unknown as InvokeCall[])
        .slice(before)
        .filter(([cmd]) => cmd === "acp_set_config_option")
        .map(([, a]) => (a as { value?: string }).value);
      expect(values).toContain("high");
      expect(values).not.toContain("qwen3-max(openai)");
    });

    it("remembers the effort Qwen settles on when a model change resets it", async () => {
      await renderWithQwen();
      const spy = withModels();
      await startQwenSession(spy);
      await pick("Effort", "High");
      await pick("Model", "Qwen3 Max");
      expect(screen.getByRole("button", { name: "Effort: Low" })).toBeDefined();

      const calls = await nextSessionCalls(spy);

      expect(calls).toContain("acp_set_config_option:qwen3-max(openai)");
      expect(calls).not.toContain("acp_set_config_option:high");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("applies a remembered effort that only the remembered model offers, after switching to it", async () => {
      await renderWithQwen();
      const spy = withModels();
      await startQwenSession(spy);
      await pick("Model", "Qwen3 Max");
      await pick("Effort", "Max");

      const calls = await nextSessionCalls(spy);

      const model = calls.indexOf("acp_set_config_option:qwen3-max(openai)");
      const effort = calls.indexOf("acp_set_config_option:max");
      const prompt = calls.findIndex((c) => c.startsWith("acp_prompt"));
      expect(model).toBeGreaterThanOrEqual(0);
      expect(effort).toBeGreaterThan(model);
      expect(prompt).toBeGreaterThan(effort);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("switches the model of a running session and shows the new one", async () => {
      await renderWithQwen();
      const spy = withModels();
      await startQwenSession(spy);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Model: Coder Model" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("option", { name: "Qwen3 Max" }));
      });

      expect(callsTo(spy, "acp_set_config_option").at(-1)?.[1]).toMatchObject({ configId: "model", value: "qwen3-max(openai)" });
      expect(screen.getByRole("button", { name: "Model: Qwen3 Max" })).toBeDefined();
    });

    it("starts the next session with the model picked last, and remembers it", async () => {
      await renderWithQwen();
      const spy = withModels();
      await startQwenSession(spy);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Model: Coder Model" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("option", { name: "Qwen3 Max" }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
      });
      expect(screen.getByRole("button", { name: "Model: Qwen3 Max" })).toBeDefined();
      const before = (spy.mock.calls as unknown as InvokeCall[]).length;
      await send("next task");
      await waitFor(() => expect(callsTo(spy, "acp_prompt").length).toBeGreaterThan(1));

      const later = (spy.mock.calls as unknown as InvokeCall[]).slice(before).map(([cmd, a]) => [cmd, (a as { value?: string })?.value]);
      const setIndex = later.findIndex(([cmd, value]) => cmd === "acp_set_config_option" && value === "qwen3-max(openai)");
      expect(setIndex).toBeGreaterThanOrEqual(0);
      expect(setIndex).toBeLessThan(later.findIndex(([cmd]) => cmd === "acp_prompt"));
      await waitFor(() =>
        // As Qwen settled it: the model picked, and the effort it kept.
        expect((fakeStore().state as { agentOptions?: Record<string, { preferredConfig?: unknown }> }).agentOptions?.["qwen-code"]?.preferredConfig).toEqual({
          model: "qwen3-max(openai)",
          reasoning_effort: "low",
        })
      );
    });

    it("starts the next session with the effort picked last too", async () => {
      await renderWithQwen();
      const spy = withModels();
      await startQwenSession(spy);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Effort: Low" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("option", { name: "High" }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
      });
      expect(screen.getByRole("button", { name: "Effort: High" })).toBeDefined();
      const before = (spy.mock.calls as unknown as InvokeCall[]).length;
      await send("next task");
      await waitFor(() => expect(callsTo(spy, "acp_prompt").length).toBeGreaterThan(1));

      const later = (spy.mock.calls as unknown as InvokeCall[]).slice(before).map(([cmd, a]) => [cmd, (a as { value?: string })?.value]);
      const setIndex = later.findIndex(([cmd, value]) => cmd === "acp_set_config_option" && value === "high");
      expect(setIndex).toBeGreaterThanOrEqual(0);
      expect(setIndex).toBeLessThan(later.findIndex(([cmd]) => cmd === "acp_prompt"));
    });

    it("keeps the remembered effort for every later session, not only the next one", async () => {
      await renderWithQwen();
      const spy = withModels();
      await startQwenSession(spy);
      await pick("Model", "Qwen3 Max");
      await pick("Effort", "Max");

      await nextSessionCalls(spy);
      const third = await nextSessionCalls(spy);

      expect(third).toContain("acp_set_config_option:qwen3-max(openai)");
      expect(third).toContain("acp_set_config_option:max");
    });

    it("starts a new session with the model switched to last, not one picked before an earlier session", async () => {
      await renderWithQwen();
      const spy = withModels();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
      });
      await send("get started");
      await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(1));
      const sessionId = String(callsTo(spy, "acp_start_session")[0][1]?.sessionId);
      await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });
      // A model picked in the draft before the second session, then switched back during it.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
      });
      await pick("Model", "Qwen3 Max");
      await send("second");
      await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(2));
      const second = String(callsTo(spy, "acp_start_session")[1][1]?.sessionId);
      await acpEvent({ sessionId: second, kind: "turn-end", stopReason: "end_turn" });
      await pick("Model", "Coder Model");

      const calls = await nextSessionCalls(spy);

      expect(screen.getByRole("button", { name: "Model: Coder Model" })).toBeDefined();
      expect(calls).not.toContain("acp_set_config_option:qwen3-max(openai)");
    });

    it("applies a model picked before the session starts, before its first prompt", async () => {
      await renderWithQwen();
      const spy = withModels();
      await startQwenSession(spy);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Model: Coder Model" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("option", { name: "Qwen3 Max" }));
      });
      const before = (spy.mock.calls as unknown as InvokeCall[]).length;
      await send("which model are you?");
      await waitFor(() => expect(callsTo(spy, "acp_prompt").length).toBeGreaterThan(1));

      const later = (spy.mock.calls as unknown as InvokeCall[]).slice(before).map(([cmd, a]) => [cmd, (a as { value?: string })?.value]);
      const setIndex = later.findIndex(([cmd, value]) => cmd === "acp_set_config_option" && value === "qwen3-max(openai)");
      const promptIndex = later.findIndex(([cmd]) => cmd === "acp_prompt");
      expect(setIndex).toBeGreaterThanOrEqual(0);
      expect(setIndex).toBeLessThan(promptIndex);
    });
  });

  it("reads the branch again when the agent's turn ends, as it may have checked out another", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("make a branch");
    const reads = () => callsTo(spy, "workspace_details").length;
    const before = reads();

    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });

    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("shows the session's cost in the context details when the agent reports it", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);

    await acpEvent({
      sessionId,
      kind: "update",
      update: { sessionUpdate: "usage_update", used: 1_000, size: 10_000, cost: { amount: 1.5, currency: "USD" } },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Context details" }));
    });

    expect(within(screen.getByRole("dialog", { name: "Context usage" })).getByText("$1.50")).toBeDefined();
  });

  it("shows the context the agent has used, as it reports it", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);

    await acpEvent({ sessionId, kind: "update", update: { sessionUpdate: "usage_update", used: 250_000, size: 1_000_000 } });

    expect(screen.getByRole("meter", { name: "Context used" }).getAttribute("aria-valuenow")).toBe("25");
  });

  it("shows the agent working while a session starts, before it has any message", async () => {
    const spy = await renderWithQwen();
    spy.mockImplementation((cmd, args) =>
      cmd === "acp_start_session" ? new Promise(() => {}) : realInvoke(cmd, args)
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });
    await send(FIRST_MESSAGE);

    expect(screen.getByTestId("agent-working")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "No session yet" })).toBeNull();
  });

  it("stops showing 'Working' while the agent waits for a permission answer", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("clean up");
    expect(screen.getByTestId("agent-working")).toBeDefined();

    await acpEvent({
      sessionId,
      kind: "permission",
      requestId: 21,
      toolCall: { title: "Delete build" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });

    expect(screen.queryByTestId("agent-working")).toBeNull();
  });

  it("marks a session waiting for the user's answer instead of working", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("clean up");
    const row = () => within(screen.getByRole("list", { name: /^Sessions in/ })).getAllByRole("listitem")[0];

    await acpEvent({
      sessionId,
      kind: "permission",
      requestId: 31,
      toolCall: { title: "Delete build" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });

    expect(within(row()).queryByLabelText("Agent working")).toBeNull();
    expect(within(row()).getByLabelText("Waiting for your answer")).toBeDefined();
  });

  it("opens another session at its latest messages after scrolling up in this one", async () => {
    fakeStore().state.sessions = [
      { id: "s-a", name: "Alpha", profileId: "qwen", cwd: "/Users/test/developer/ai-perpetual-trading", status: "terminated", createdAt: 2, transport: "acp" },
      { id: "s-b", name: "Beta", profileId: "qwen", cwd: "/Users/test/developer/ai-perpetual-trading", status: "terminated", createdAt: 1, transport: "acp" },
    ];
    fakeStore().transcripts["s-a"] = [{ id: "m-a", role: "user", content: "alpha question", timestamp: 1 }];
    fakeStore().transcripts["s-b"] = [{ id: "m-b", role: "user", content: "beta question", timestamp: 1 }];
    await renderWithQwen();
    const open = async (name: string) => {
      await act(async () => {
        fireEvent.click(within(screen.getByRole("complementary")).getByText(name));
      });
    };
    // Load both transcripts, so switching shows no empty state in between.
    await open("Beta");
    await screen.findByText("beta question");
    await open("Alpha");
    await screen.findByText("alpha question");
    const view = screen.getByTestId("chat-canvas-container");
    Object.defineProperty(view, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(view, "clientHeight", { configurable: true, value: 400 });
    view.scrollTop = 100;
    fireEvent.scroll(view);

    await open("Beta");

    // The other session opens at its newest output, in the same view (so Read aloud keeps playing).
    expect(await screen.findByText("beta question")).toBeDefined();
    expect(screen.getByTestId("chat-canvas-container")).toBe(view);
    expect(view.scrollTop).toBe(2000);
  });
});

