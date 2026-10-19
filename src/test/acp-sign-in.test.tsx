import { describe, it, expect, vi, afterEach } from "vitest";
import { render, renderHook, screen, act, fireEvent, within, waitFor } from "@testing-library/react";
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

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {}
    write(_data: string, callback?: () => void) {
      callback?.();
    }
    onData() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import App from "../App";
import { useAgentSignIn } from "../hooks/useAgentSignIn";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
type InvokeCall = [string, Record<string, unknown> | undefined, ...unknown[]];
type Override = (args: Record<string, unknown> | undefined) => Promise<unknown>;

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

function callsTo(spy: { mock: { calls: unknown[][] } }, cmd: string) {
  return (spy.mock.calls as unknown as InvokeCall[]).filter(([name]) => name === cmd);
}

async function terminalEvent(payload: Record<string, unknown>) {
  await act(async () => {
    listeners.get("sign-in-terminal")?.({ payload });
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

const TERMINAL_METHODS = [{ id: "claude-ai-login", name: "Claude Subscription", type: "terminal" }];

/** The re-check after a sign-in, which only asks whether someone is signed in. */
const isRecheck = (args: Record<string, unknown> | undefined) => args?.needsOptions === false;

/**
 * Sends "hello" to a new session whose agent refuses to start until the user
 * signs in (`refusals` times), and waits for the sign-in panel.
 */
async function sendRefused({
  methods = TERMINAL_METHODS,
  refusals = 1,
  overrides = {},
}: { methods?: unknown[]; refusals?: number; overrides?: Record<string, Override> } = {}) {
  const spy = await renderWithQwen();
  let starts = 0;
  spy.mockImplementation((cmd, args) => {
    if (cmd === "acp_start_session" && starts++ < refusals) {
      return Promise.reject(`ACP_AUTH_REQUIRED:${JSON.stringify(methods)}`);
    }
    const override = overrides[cmd];
    return override ? override(args) : realInvoke(cmd, args);
  });
  await send("hello");
  const panel = within(await screen.findByRole("region", { name: "Sign in to Qwen Code" }));
  expect(prompt().value).toBe("hello");
  return { spy, panel };
}

/** Clicks the terminal sign-in and returns its dialog and the id of the login's terminal. */
async function startTerminalSignIn(spy: { mock: { calls: unknown[][] } }, panel: ReturnType<typeof within>) {
  await act(async () => {
    fireEvent.click(panel.getByRole("button", { name: "Sign in with Claude Subscription" }));
  });
  const dialog = within(await screen.findByRole("dialog", { name: "Sign in to Qwen Code" }));
  const terminalId = String(callsTo(spy, "acp_start_terminal_sign_in")[0][1]?.terminalId);
  return { dialog, terminalId };
}

/** Signs in through the terminal login, which ends with `exitCode`. */
async function signInInTerminal(spy: { mock: { calls: unknown[][] } }, panel: ReturnType<typeof within>, exitCode = 0) {
  const { dialog, terminalId } = await startTerminalSignIn(spy, panel);
  await terminalEvent({ terminalId, kind: "exit", exitCode });
  return dialog;
}

/** A promise the test settles itself, for an answer that comes while the user acts. */
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function promptedTexts(spy: { mock: { calls: unknown[][] } }) {
  return callsTo(spy, "acp_prompt").map(([, args]) => args?.text);
}

describe("signing in to an ACP agent from the app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
  });

  it("signs in through the agent's terminal login and sends the refused message", async () => {
    const { spy, panel } = await sendRefused();

    await signInInTerminal(spy, panel);

    await waitFor(() => expect(callsTo(spy, "acp_start_session")).toHaveLength(2));
    await waitFor(() => expect(promptedTexts(spy)).toEqual(["hello"]));
    expect(prompt().value).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("region", { name: "Sign in to Qwen Code" })).toBeNull();
  });

  it("shows the session running again once the refused message is sent", async () => {
    const { spy, panel } = await sendRefused();

    await signInInTerminal(spy, panel);

    await waitFor(() => expect(promptedTexts(spy)).toEqual(["hello"]));
    await waitFor(() => expect(fakeStore().state.sessions).toMatchObject([{ status: "running", endedAt: null }]));
  });

  it("puts the message back in the composer when sending it again fails", async () => {
    const { spy, panel } = await sendRefused({
      overrides: { acp_start_session: () => Promise.reject("spawn failed") },
    });

    await signInInTerminal(spy, panel);

    await waitFor(() => expect(callsTo(spy, "acp_start_session")).toHaveLength(2));
    await waitFor(() => expect(prompt().value).toBe("hello"));
    expect(callsTo(spy, "acp_prompt")).toHaveLength(0);
  });

  it("keeps the dialog open with the reason when the login fails", async () => {
    const { spy, panel } = await sendRefused();

    const dialog = await signInInTerminal(spy, panel, 1);

    expect(dialog.getByText("The sign-in ended with code 1")).toBeDefined();
    expect(dialog.getByRole("button", { name: "Try again" })).toBeDefined();
    expect(callsTo(spy, "acp_start_session")).toHaveLength(1);
    expect(callsTo(spy, "acp_prompt")).toHaveLength(0);
  });

  it("says the agent still is signed out when it says so after the login", async () => {
    const { spy, panel } = await sendRefused({
      overrides: {
        acp_probe_agent: (args) => (isRecheck(args) ? Promise.reject("ACP_AUTH_REQUIRED:[]") : realInvoke("acp_probe_agent", args)),
      },
    });

    const dialog = await signInInTerminal(spy, panel);

    expect(await dialog.findByText("Qwen Code still says you are signed out")).toBeDefined();
    expect(callsTo(spy, "acp_start_session")).toHaveLength(1);
    expect(callsTo(spy, "acp_prompt")).toHaveLength(0);
  });

  it("cancelling stops the login and leaves the message", async () => {
    const { spy, panel } = await sendRefused();
    const { dialog, terminalId } = await startTerminalSignIn(spy, panel);

    await act(async () => {
      fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    });

    expect(callsTo(spy, "terminate_session").map(([, args]) => args)).toContainEqual({ sessionId: terminalId });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      (panel.getByRole("button", { name: "Sign in with Claude Subscription" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(prompt().value).toBe("hello");
  });

  it("does not send a message the user changed", async () => {
    const { spy, panel } = await sendRefused();
    await act(async () => {
      fireEvent.change(prompt(), { target: { value: "hello there" } });
    });

    await signInInTerminal(spy, panel);

    expect(await screen.findByText("Signed in to Qwen Code. Send your message again.")).toBeDefined();
    expect(callsTo(spy, "acp_start_session")).toHaveLength(1);
    expect(prompt().value).toBe("hello there");
  });

  it("does not send into another session", async () => {
    const { spy, panel } = await sendRefused();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });

    await signInInTerminal(spy, panel);

    expect(await screen.findByText("Signed in to Qwen Code. Send your message again.")).toBeDefined();
    expect(callsTo(spy, "acp_start_session")).toHaveLength(1);
  });

  it("an agent sign-in sends the refused message too", async () => {
    const { spy, panel } = await sendRefused({
      methods: [{ id: "chat-gpt", name: "ChatGPT" }],
      overrides: { acp_authenticate: () => Promise.resolve(undefined) },
    });

    await act(async () => {
      fireEvent.click(panel.getByRole("button", { name: "Sign in with ChatGPT" }));
    });

    await waitFor(() => expect(callsTo(spy, "acp_start_session")).toHaveLength(2));
    await waitFor(() => expect(promptedTexts(spy)).toEqual(["hello"]));
    expect(screen.queryByRole("region", { name: "Sign in to Qwen Code" })).toBeNull();
  });

  it("a second refusal opens the panel again without retrying", async () => {
    const { spy, panel } = await sendRefused({ refusals: Infinity });

    await signInInTerminal(spy, panel);

    await waitFor(() => expect(callsTo(spy, "acp_start_session")).toHaveLength(2));
    const again = within(await screen.findByRole("region", { name: "Sign in to Qwen Code" }));
    expect(again.getByRole("button", { name: "Sign in with Claude Subscription" })).toBeDefined();
    await waitFor(() => expect(prompt().value).toBe("hello"));
    expect(callsTo(spy, "acp_start_session")).toHaveLength(2);
    expect(callsTo(spy, "acp_prompt")).toHaveLength(0);
  });

  it("cancelling while the sign-in is checked sends nothing and leaves the message", async () => {
    const recheck = deferred();
    const { spy, panel } = await sendRefused({
      overrides: {
        acp_probe_agent: (args) => (isRecheck(args) ? recheck.promise : realInvoke("acp_probe_agent", args)),
      },
    });
    const dialog = await signInInTerminal(spy, panel);
    expect(await dialog.findByText("Checking your sign-in…")).toBeDefined();

    await act(async () => {
      fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    });
    await act(async () => {
      recheck.resolve(undefined);
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(callsTo(spy, "acp_start_session")).toHaveLength(1);
    expect(prompt().value).toBe("hello");
    expect(
      (panel.getByRole("button", { name: "Sign in with Claude Subscription" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("a sign-in dismissed while it runs sends nothing", async () => {
    const authenticate = deferred();
    const { spy, panel } = await sendRefused({
      methods: [{ id: "chat-gpt", name: "ChatGPT" }],
      overrides: { acp_authenticate: () => authenticate.promise },
    });
    await act(async () => {
      fireEvent.click(panel.getByRole("button", { name: "Sign in with ChatGPT" }));
    });

    await act(async () => {
      fireEvent.click(panel.getByRole("button", { name: "Dismiss sign-in" }));
    });
    await act(async () => {
      authenticate.resolve(undefined);
    });

    expect(callsTo(spy, "acp_start_session")).toHaveLength(1);
    expect(prompt().value).toBe("hello");
  });

  it("offers only Close when the agent no longer offers the sign-in", async () => {
    const { panel } = await sendRefused({
      overrides: {
        acp_start_terminal_sign_in: () =>
          Promise.reject(`ACP_AUTH_REQUIRED:${JSON.stringify([{ id: "other", name: "Other", type: "terminal" }])}`),
      },
    });

    await act(async () => {
      fireEvent.click(panel.getByRole("button", { name: "Sign in with Claude Subscription" }));
    });

    const dialog = within(await screen.findByRole("dialog", { name: "Sign in to Qwen Code" }));
    expect(await dialog.findByText("Qwen Code no longer offers this sign-in")).toBeDefined();
    expect(dialog.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(dialog.getByRole("button", { name: "Close" })).toBeDefined();
  });

  it("closes the login's dialog when another sign-in request replaces it", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");
    const { result } = renderHook(() =>
      useAgentSignIn({
        agents: [],
        composerRef: { current: null },
        activeSessionIdRef: { current: "session-a" },
        retryAfterSignIn: () => Promise.resolve(true),
        onRestore: () => {},
      }),
    );
    const methods = [{ id: "login", name: "Log in", kind: "terminal" as const }];
    act(() => result.current.auth.requestSignIn("agent-a", "/work", methods));
    await act(async () => result.current.auth.signIn("login"));
    expect(result.current.terminal.dialog).not.toBeNull();
    const terminalId = result.current.terminal.dialog?.terminalId;

    act(() => result.current.auth.requestSignIn("agent-b", "/work", methods));

    expect(result.current.terminal.dialog).toBeNull();
    expect(callsTo(spy, "terminate_session").map(([, args]) => args)).toContainEqual({ sessionId: terminalId });
  });

  it("a sign-in that ends after its panel gave way to another agent's leaves that one alone", async () => {
    const authenticate = deferred();
    const real = tauriInternals().invoke;
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "acp_authenticate" ? authenticate.promise : real(cmd, args),
    );
    const retryAfterSignIn = vi.fn();
    const { result } = renderHook(() =>
      useAgentSignIn({
        agents: [],
        composerRef: { current: null },
        activeSessionIdRef: { current: "session-a" },
        retryAfterSignIn,
        onRestore: () => {},
      }),
    );
    const methods = [{ id: "chat-gpt", name: "ChatGPT", kind: "agent" as const }];
    act(() => result.current.auth.requestSignIn("agent-a", "/work", methods));
    act(() => result.current.auth.signIn("chat-gpt"));

    act(() => result.current.auth.dismiss());
    act(() => result.current.auth.requestSignIn("agent-b", "/work", methods));
    await act(async () => {
      authenticate.resolve(undefined);
    });

    expect(result.current.auth.authRequest).toEqual({ profileId: "agent-b", cwd: "/work", methods, status: "idle" });
    expect(retryAfterSignIn).not.toHaveBeenCalled();
  });
});
