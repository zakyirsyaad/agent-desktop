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
  return (spy.mock.calls as InvokeCall[]).filter(([name]) => name === cmd);
}

async function acpEvent(payload: Record<string, unknown>) {
  await act(async () => {
    listeners.get("acp-event")?.({ payload });
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

async function startQwenSession(spy: { mock: { calls: unknown[][] } }) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
  });
  const [, args] = callsTo(spy, "acp_start_session")[0];
  return String(args?.sessionId);
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

describe("ACP sessions in the app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
  });

  it("starts an ACP agent by profile and switches a risky starting mode to the safe one", async () => {
    const spy = await renderWithQwen();

    const sessionId = await startQwenSession(spy);

    const [, startArgs] = callsTo(spy, "acp_start_session")[0];
    expect(startArgs).toMatchObject({ profileId: "qwen", cwd: "/Users/test/developer/ai-perpetual-trading" });
    expect(callsTo(spy, "spawn_session")).toHaveLength(0);
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

  it("marks the session ended when the agent exits", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);

    await acpEvent({ sessionId, kind: "exit", code: 1 });

    const sidebar = within(screen.getByRole("complementary"));
    const row = sidebar.getByText("Session #1").closest("li") as HTMLElement;
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
    expect(within(screen.getByRole("complementary")).getByText("plan it (fork)")).toBeDefined();
  });

  it("stops a live ACP agent when its session is deleted and ignores its late events", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    const row = within(screen.getByRole("complementary")).getByText("Session #1").closest("li") as HTMLElement;

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

    await waitFor(() =>
      expect(callsTo(spy, "acp_stop_session").map(([, a]) => a)).toContainEqual({ sessionId })
    );
    expect(callsTo(spy, "acp_prompt")).toHaveLength(0);
    expect(callsTo(spy, "acp_set_mode")).toHaveLength(0);
  });

  it("does not send another prompt while the agent is still working", async () => {
    const spy = await renderWithQwen();
    await startQwenSession(spy);
    await send("first");

    await send("second");

    expect(callsTo(spy, "acp_prompt")).toHaveLength(1);
    expect((screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement).value).toBe("second");
  });

  it("offers no terminal drawer in the main window: terminal agents show their screen as the main view", async () => {
    const spy = await renderWithQwen();
    await startQwenSession(spy);

    expect(screen.queryByRole("button", { name: "Toggle terminal drawer" })).toBeNull();
  });

  it("remembers the options an agent reported, for the composer before the next session", async () => {
    const spy = await renderWithQwen();
    await startQwenSession(spy);

    await waitFor(() => {
      const options = fakeStore().state.agentOptions as Record<string, { modes?: { availableModes: unknown[] } }>;
      expect(options?.qwen?.modes?.availableModes).toHaveLength(2);
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
    expect(callsTo(spy, "acp_load_session")[0][1]).toMatchObject({
      sessionId: "s-old",
      profileId: "qwen",
      cwd: "/Users/test/developer/ai-perpetual-trading",
      acpSessionId: "qwen-old",
    });
    expect(callsTo(spy, "acp_prompt")[0][1]).toMatchObject({ sessionId: "s-old", text: "next step" });
    expect(callsTo(spy, "acp_start_session")).toHaveLength(0);
    expect(within(screen.getByRole("complementary")).queryByText("Session #5")).toBeNull();
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
      cmd === "acp_load_session" ? Promise.reject("session not found") : realInvoke(cmd, args)
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
      expect(options?.qwen?.commands).toEqual([
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

  it("renames a numbered session on its first message only", async () => {
    const spy = await renderWithQwen();
    await startQwenSession(spy);
    const sidebar = within(screen.getByRole("complementary"));
    expect(sidebar.getByText("Session #1")).toBeDefined();

    await send("first question");
    await acpEvent({ sessionId: String(callsTo(spy, "acp_start_session")[0][1]?.sessionId), kind: "turn-end", stopReason: "end_turn" });
    await send("second question");

    expect(sidebar.getByText("first question")).toBeDefined();
    expect(sidebar.queryByText("Session #1")).toBeNull();
    expect(sidebar.queryByText("second question")).toBeNull();
  });

  it("asks the user to sign in when the agent needs it, and signs in with a method that needs no secret", async () => {
    const spy = await renderWithQwen();
    const methods = [
      { id: "api-key", name: "API Key", description: "Use an API key to authenticate", _meta: { "api-key": {} } },
      { id: "chat-gpt", name: "ChatGPT", description: "Use ChatGPT to authenticate" },
    ];
    spy.mockImplementation((cmd, args) =>
      cmd === "acp_start_session"
        ? Promise.reject(`ACP_AUTH_REQUIRED:${JSON.stringify(methods)}`)
        : cmd === "acp_authenticate"
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
      profileId: "qwen",
      cwd: "/Users/test/developer/ai-perpetual-trading",
      methodId: "chat-gpt",
    });
    expect(await screen.findByText(/Signed in to Qwen Code/)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
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

    expect(callsTo(spy, "acp_prompt")[0][1]).toMatchObject({
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

