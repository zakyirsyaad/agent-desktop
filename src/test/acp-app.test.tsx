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
    expect(screen.getByText("explain the parser")).toBeDefined();
  });

  it("streams the agent's reply and ends the turn", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    await send("hi");
    expect(screen.getByTestId("thinking-indicator-ring")).toBeDefined();

    await acpEvent({
      sessionId,
      kind: "update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello from Qwen" } },
    });
    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });

    expect(screen.getByText("Hello from Qwen")).toBeDefined();
    expect(screen.queryByTestId("thinking-indicator-ring")).toBeNull();
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
    const row = () => within(screen.getByRole("complementary")).getByText("Session #1").closest("li") as HTMLElement;
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
    expect(screen.queryByTestId("thinking-indicator-ring")).toBeNull();
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
    expect(within(screen.getByRole("complementary")).getByText("Session #1 (fork)")).toBeDefined();
  });

  it("stops a live ACP agent when its session is deleted and ignores its late events", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startQwenSession(spy);
    const row = within(screen.getByRole("complementary")).getByText("Session #1").closest("li") as HTMLElement;

    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Delete session" }));
    });
    await acpEvent({ sessionId, kind: "exit", code: 0 });

    expect(callsTo(spy, "acp_stop_session").map(([, a]) => a)).toContainEqual({ sessionId });
    await new Promise((resolve) => setTimeout(resolve, 400));
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
    const row = within(screen.getByRole("complementary")).getByText("Session #1").closest("li") as HTMLElement;
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

  it("explains in the terminal drawer that an ACP agent has no terminal", async () => {
    const spy = await renderWithQwen();
    await startQwenSession(spy);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Toggle terminal drawer" }));
    });

    expect(screen.getByText(/has no terminal/i)).toBeDefined();
    expect(screen.queryByText(/no running session/i)).toBeNull();
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
});

