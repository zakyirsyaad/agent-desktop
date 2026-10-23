import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, renderHook } from "@testing-library/react";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
  emit: () => Promise.resolve(),
}));

type FakeTerminal = { written: string[]; type: (data: string) => void };
const { terminals } = vi.hoisted(() => ({ terminals: [] as FakeTerminal[] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    written: string[] = [];
    cols = 80;
    rows = 24;
    constructor() {
      terminals.push(this);
    }
    loadAddon() {}
    open() {}
    focus() {}
    write(data: string, callback?: () => void) {
      this.written.push(data);
      callback?.();
    }
    /** Types into the terminal, as the user would: reaches the onData handler once there is one. */
    type: (data: string) => void = () => {};
    onData(handler: (data: string) => void) {
      this.type = handler;
      return { dispose() {} };
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { useTerminalSignIn, type LoginOutcome } from "../hooks/useTerminalSignIn";
import { sweepOrphans } from "../lib/orphan-sweep";
import { TerminalSignInDialog } from "../components/TerminalSignInDialog";
import { createPtyOutputStore } from "../lib/pty-output-store";
import type { AuthMethod } from "../lib/acp-auth";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
type InvokeCall = [string, Record<string, unknown> | undefined];

function internals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function callsTo(spy: { mock: { calls: unknown[][] } }, cmd: string) {
  return (spy.mock.calls as unknown as InvokeCall[]).filter(([name]) => name === cmd);
}

async function terminalEvent(payload: Record<string, unknown>) {
  await act(async () => {
    listeners.get("sign-in-terminal")?.({ payload });
  });
}

const METHOD: AuthMethod = { id: "login", name: "Log in with Qwen", kind: "terminal" };
const REQUEST = { profileId: "qwen", cwd: "/work", agentName: "Qwen Code", method: METHOD };

/** Replaces one command, passing the rest to the fake backend. */
function mockStart(impl: () => Promise<unknown>) {
  const real = internals().invoke;
  return vi.spyOn(internals(), "invoke").mockImplementation((cmd, args) =>
    cmd === "acp_start_terminal_sign_in" ? impl() : real(cmd, args),
  );
}

async function startRun(result: { current: ReturnType<typeof useTerminalSignIn> }) {
  let outcome!: Promise<LoginOutcome>;
  await act(async () => {
    outcome = result.current.run(REQUEST);
  });
  return { outcome };
}

afterEach(() => {
  listeners.clear();
  terminals.length = 0;
  vi.restoreAllMocks();
});

describe("useTerminalSignIn", () => {
  it("starts the login with a sign-in terminal id and succeeds on exit 0", async () => {
    const spy = mockStart(() => Promise.resolve());
    const { result } = renderHook(() => useTerminalSignIn());
    const { outcome } = await startRun(result);

    const [[, args]] = callsTo(spy, "acp_start_terminal_sign_in");
    expect(args).toMatchObject({ profileId: "qwen", cwd: "/work", methodId: "login" });
    expect(args?.terminalId).toMatch(/^signin-[a-z0-9-]+$/);
    expect(result.current.dialog).toMatchObject({
      terminalId: args?.terminalId,
      agentName: "Qwen Code",
      methodName: "Log in with Qwen",
      phase: "running",
    });

    await terminalEvent({ terminalId: args?.terminalId, kind: "exit", exitCode: 0 });
    await expect(outcome).resolves.toEqual({ ok: true });
  });

  it("starts the login only once the startup orphan sweep is done", async () => {
    // The sweep ends every PTY it finds, the sign-in terminal included.
    let finishSweep = () => {};
    const real = internals().invoke;
    const spy = vi.spyOn(internals(), "invoke").mockImplementation((cmd, args) => {
      if (cmd === "end_orphaned_sessions") return new Promise((resolve) => (finishSweep = () => resolve(0)));
      if (cmd === "acp_start_terminal_sign_in") return Promise.resolve();
      return real(cmd, args);
    });
    void sweepOrphans();
    const { result } = renderHook(() => useTerminalSignIn());
    await startRun(result);

    expect(callsTo(spy, "acp_start_terminal_sign_in")).toHaveLength(0);
    await act(async () => {
      finishSweep();
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    });
    expect(callsTo(spy, "acp_start_terminal_sign_in")).toHaveLength(1);
  });

  it("starts no login when it is cancelled while the orphan sweep runs", async () => {
    // A login program can open a browser at once, so a cancelled one must not start at all.
    let finishSweep = () => {};
    const real = internals().invoke;
    const spy = vi.spyOn(internals(), "invoke").mockImplementation((cmd, args) => {
      if (cmd === "end_orphaned_sessions") return new Promise((resolve) => (finishSweep = () => resolve(0)));
      if (cmd === "acp_start_terminal_sign_in") return Promise.resolve();
      return real(cmd, args);
    });
    void sweepOrphans();
    const { result } = renderHook(() => useTerminalSignIn());
    const { outcome } = await startRun(result);

    await act(async () => {
      result.current.close();
    });
    await act(async () => {
      finishSweep();
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    });

    expect(callsTo(spy, "acp_start_terminal_sign_in")).toHaveLength(0);
    expect(callsTo(spy, "terminate_session")).toHaveLength(0);
    await expect(outcome).resolves.toEqual({ ok: false, reason: "Sign-in cancelled", cancelled: true });
  });

  it("fails with the exit code", async () => {
    const spy = mockStart(() => Promise.resolve());
    const { result } = renderHook(() => useTerminalSignIn());
    const { outcome } = await startRun(result);
    const [[, args]] = callsTo(spy, "acp_start_terminal_sign_in");

    await terminalEvent({ terminalId: args?.terminalId, kind: "exit", exitCode: 1 });
    await expect(outcome).resolves.toEqual({ ok: false, reason: "The sign-in ended with code 1" });
    expect(result.current.dialog?.phase).toBe("failed");
    expect(result.current.dialog?.error).toBe("The sign-in ended with code 1");
  });

  it("cancelling a running login terminates it", async () => {
    const spy = mockStart(() => Promise.resolve());
    const { result } = renderHook(() => useTerminalSignIn());
    const { outcome } = await startRun(result);
    const [[, args]] = callsTo(spy, "acp_start_terminal_sign_in");

    await act(async () => result.current.close());
    expect(callsTo(spy, "terminate_session")[0][1]).toEqual({ sessionId: args?.terminalId });
    await expect(outcome).resolves.toEqual({ ok: false, reason: "Sign-in cancelled", cancelled: true });
    expect(result.current.dialog).toBeNull();
  });

  it("cancelling while starting terminates the login once it is up", async () => {
    let finishStart!: () => void;
    const spy = mockStart(() => new Promise<void>((resolve) => (finishStart = resolve)));
    const { result } = renderHook(() => useTerminalSignIn());
    const { outcome } = await startRun(result);
    expect(result.current.dialog?.phase).toBe("starting");

    await act(async () => result.current.close());
    expect(callsTo(spy, "terminate_session")).toHaveLength(0);
    // The backend ends the agent the method is read from, so no terminal starts.
    const terminalId = callsTo(spy, "acp_start_terminal_sign_in")[0][1]?.terminalId;
    expect(callsTo(spy, "acp_cancel_terminal_sign_in")[0][1]).toEqual({ terminalId });

    await act(async () => finishStart());
    expect(callsTo(spy, "terminate_session")).toHaveLength(1);
    await expect(outcome).resolves.toMatchObject({ ok: false, cancelled: true });
    expect(result.current.dialog).toBeNull();
  });

  it("stays failed when the login exits before the start resolves", async () => {
    let finishStart!: () => void;
    const spy = mockStart(() => new Promise<void>((resolve) => (finishStart = resolve)));
    const { result } = renderHook(() => useTerminalSignIn());
    const { outcome } = await startRun(result);
    const id = result.current.dialog?.terminalId;

    await terminalEvent({ terminalId: id, kind: "exit", exitCode: 1 });
    await act(async () => finishStart());

    await expect(outcome).resolves.toEqual({ ok: false, reason: "The sign-in ended with code 1" });
    expect(result.current.dialog).toMatchObject({ phase: "failed", error: "The sign-in ended with code 1" });
    expect(callsTo(spy, "terminate_session")).toHaveLength(0);
  });

  it("reports a method the agent no longer offers", async () => {
    const payload = JSON.stringify([{ id: "other", name: "Other", type: "terminal" }]);
    mockStart(() => Promise.reject(`ACP_AUTH_REQUIRED:${payload}`));
    const { result } = renderHook(() => useTerminalSignIn());
    const { outcome } = await startRun(result);

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      reason: "Qwen Code no longer offers this sign-in",
      methods: [{ id: "other", name: "Other" }],
    });
    expect(result.current.dialog?.phase).toBe("failed");
  });

  it("shows any other start error as its text", async () => {
    mockStart(() => Promise.reject("spawn failed"));
    const { result } = renderHook(() => useTerminalSignIn());
    const { outcome } = await startRun(result);
    await expect(outcome).resolves.toEqual({ ok: false, reason: "spawn failed" });
    expect(result.current.dialog).toMatchObject({ phase: "failed", error: "spawn failed" });
  });

  it("collects output for its own terminal only", async () => {
    const spy = mockStart(() => Promise.resolve());
    const { result } = renderHook(() => useTerminalSignIn());
    await startRun(result);
    const [[, args]] = callsTo(spy, "acp_start_terminal_sign_in");
    const id = args?.terminalId as string;

    await terminalEvent({ terminalId: id, kind: "output", data: "Open the link" });
    await terminalEvent({ terminalId: "signin-other", kind: "output", data: "nope" });
    expect(result.current.output.snapshot(id)).toBe("Open the link");
  });

  it("forwards input and resizes to the terminal", async () => {
    const spy = mockStart(() => Promise.resolve());
    const { result } = renderHook(() => useTerminalSignIn());
    await startRun(result);
    const [[, args]] = callsTo(spy, "acp_start_terminal_sign_in");

    await act(async () => {
      result.current.sendInput("y");
      result.current.resize(100, 30);
    });
    expect(callsTo(spy, "send_input")[0][1]).toEqual({ sessionId: args?.terminalId, data: "y" });
    expect(callsTo(spy, "resize_session")[0][1]).toEqual({ sessionId: args?.terminalId, cols: 100, rows: 30 });
  });
});

describe("Sign-in terminal input", () => {
  /** The sign-in hook and its dialog, wired as the app wires them. */
  function SignInHarness({ onReady }: { onReady: (run: ReturnType<typeof useTerminalSignIn>["run"]) => void }) {
    const signIn = useTerminalSignIn();
    onReady(signIn.run);
    return signIn.dialog ? (
      <TerminalSignInDialog
        state={signIn.dialog}
        output={signIn.output}
        onClose={() => {}}
        onInput={signIn.sendInput}
        onResize={signIn.resize}
      />
    ) : null;
  }

  it("sends what you type in the sign-in terminal, and its size, to the sign-in PTY", async () => {
    const spy = mockStart(() => Promise.resolve());
    let run!: ReturnType<typeof useTerminalSignIn>["run"];
    render(<SignInHarness onReady={(r) => (run = r)} />);
    await act(async () => {
      void run(REQUEST);
    });
    const [[, args]] = callsTo(spy, "acp_start_terminal_sign_in");
    const terminalId = args?.terminalId as string;
    expect(terminalId).toMatch(/^signin-/);

    await act(async () => {
      terminals[terminals.length - 1].type("y");
    });

    expect(spy).toHaveBeenCalledWith("send_input", { sessionId: terminalId, data: "y" }, undefined);
    expect(spy).toHaveBeenCalledWith("resize_session", { sessionId: terminalId, cols: 80, rows: 24 }, undefined);
  });
});

describe("TerminalSignInDialog", () => {
  function renderDialog(phase: "starting" | "running" | "checking" | "failed", error?: string) {
    const output = createPtyOutputStore();
    const handlers = { onClose: vi.fn(), onTryAgain: vi.fn(), onInput: vi.fn(), onResize: vi.fn() };
    render(
      <TerminalSignInDialog
        state={{ terminalId: "signin-1", agentName: "Qwen Code", methodName: "Log in with Qwen", phase, error }}
        output={output}
        {...handlers}
      />,
    );
    return { output, ...handlers };
  }

  it("names the agent and the method", () => {
    renderDialog("running");
    expect(screen.getByRole("dialog", { name: "Sign in to Qwen Code" })).toBeTruthy();
    expect(screen.getByText("Log in with Qwen")).toBeTruthy();
  });

  it.each([
    ["starting", "Starting Qwen Code…"],
    ["running", "Finish signing in in the terminal. Zorvo continues when it closes."],
    ["checking", "Checking your sign-in…"],
  ] as const)("shows the %s copy with Cancel", (phase, copy) => {
    renderDialog(phase);
    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows the error with Try again and Close when failed", () => {
    const { onTryAgain, onClose } = renderDialog("failed", "The sign-in ended with code 1");
    expect(screen.getByText("The sign-in ended with code 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onTryAgain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const { onClose } = renderDialog("running");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("draws the output of its terminal", () => {
    const { output } = renderDialog("running");
    act(() => output.append("signin-1", "Visit the link"));
    expect(terminals[0].written).toContain("Visit the link");
  });

  it.each(["starting", "checking"] as const)("moves focus to Cancel while %s", (phase) => {
    renderDialog(phase);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("moves focus to Try again when failed, and again after each failure", () => {
    const output = createPtyOutputStore();
    const state = { terminalId: "signin-1", agentName: "Qwen Code", methodName: "Log in with Qwen" };
    const handlers = { onClose: () => {}, onTryAgain: () => {}, onInput: () => {}, onResize: () => {} };
    const { rerender } = render(
      <TerminalSignInDialog state={{ ...state, phase: "failed", error: "boom" }} output={output} {...handlers} />,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Try again" }));

    rerender(<TerminalSignInDialog state={{ ...state, phase: "starting" }} output={output} {...handlers} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("offers Close only, with focus on it, when the method cannot be tried again", () => {
    const output = createPtyOutputStore();
    render(
      <TerminalSignInDialog
        state={{ terminalId: "signin-1", agentName: "Qwen Code", methodName: "Log in with Qwen", phase: "failed", error: "gone" }}
        output={output}
        onClose={() => {}}
        onInput={() => {}}
        onResize={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("keeps Tab inside the dialog", () => {
    renderDialog("failed", "The sign-in ended with code 1");
    const first = screen.getByRole("button", { name: "Cancel sign-in" });
    const last = screen.getByRole("button", { name: "Try again" });

    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("brings Tab back into the dialog when focus is outside it", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    renderDialog("failed", "The sign-in ended with code 1");
    outside.focus();

    fireEvent.keyDown(outside, { key: "Tab" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel sign-in" }));
    outside.remove();
  });

  it("gives focus back to what opened it when it closes", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(
      <TerminalSignInDialog
        state={{ terminalId: "signin-1", agentName: "Qwen Code", methodName: "Log in with Qwen", phase: "starting" }}
        output={createPtyOutputStore()}
        onClose={() => {}}
        onTryAgain={() => {}}
        onInput={() => {}}
        onResize={() => {}}
      />,
    );
    expect(document.activeElement).not.toBe(opener);

    unmount();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
