import { StrictMode } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

type Listener = (event: { payload: unknown }) => void;
/** Every listener ever attached. `unlisten` does nothing here: a real one resolves later, so a stale listener must still be harmless. */
const attached: Listener[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    if (event === "workspace-terminal") attached.push(cb);
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));

import { useWorkspaceTerminals } from "../hooks/useWorkspaceTerminals";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
type InvokeCall = [string, Record<string, unknown> | undefined];

function internals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function callsTo(spy: { mock: { calls: unknown[][] } }, cmd: string) {
  return (spy.mock.calls as unknown as InvokeCall[]).filter(([name]) => name === cmd);
}

function emit(payload: Record<string, unknown>) {
  for (const cb of [...attached]) cb({ payload });
}

async function emitAct(payload: Record<string, unknown>) {
  await act(async () => emit(payload));
}

let nextShell = 1;
let openImpl: (path: string) => Promise<unknown>;
let closeImpl: (id: string) => Promise<unknown>;
let invokeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  attached.length = 0;
  nextShell = 1;
  openImpl = async () => `shell-${nextShell++}`;
  closeImpl = async () => undefined;
  const real = internals().invoke;
  invokeSpy = vi.spyOn(internals(), "invoke").mockImplementation((cmd, args) => {
    if (cmd === "workspace_terminal_open") return openImpl(String(args?.path));
    if (cmd === "workspace_terminal_close") return closeImpl(String(args?.id));
    if (cmd === "send_input" || cmd === "resize_session") return Promise.resolve();
    return real(cmd, args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const onNotice = vi.fn();
  let renders = 0;
  const hook = renderHook(
    () => {
      renders += 1;
      return useWorkspaceTerminals(onNotice);
    },
    { wrapper: StrictMode },
  );
  // Let the listen() promise settle.
  await act(async () => {});
  return { ...hook, onNotice, renders: () => renders };
}

async function open(result: { current: ReturnType<typeof useWorkspaceTerminals> }, folder: string) {
  let id: string | null = null;
  await act(async () => {
    id = await result.current.open(folder);
  });
  return id;
}

describe("useWorkspaceTerminals", () => {
  it("opens a terminal for a folder", async () => {
    const { result } = await setup();
    const id = await open(result, "/w/a");

    expect(id).toBe("shell-1");
    expect(callsTo(invokeSpy, "workspace_terminal_open")[0][1]).toEqual({ path: "/w/a" });
    expect(result.current.tabsFor("/w/a")).toEqual([
      { id: "shell-1", folderPath: "/w/a", number: 1, status: "live" },
    ]);
  });

  it("numbers a folder's tabs and keeps them", async () => {
    const { result } = await setup();
    await open(result, "/w/a");
    await open(result, "/w/a");
    act(() => result.current.close("shell-1"));

    expect(result.current.tabsFor("/w/a").map((tab) => [tab.id, tab.number])).toEqual([["shell-2", 2]]);

    await open(result, "/w/a");
    expect(result.current.tabsFor("/w/a").map((tab) => [tab.id, tab.number])).toEqual([
      ["shell-2", 2],
      ["shell-3", 3],
    ]);
  });

  it("keeps output that arrives before open resolves", async () => {
    const { result } = await setup();
    openImpl = async () => {
      emit({ terminalId: "shell-1", kind: "output", data: "$ " });
      return "shell-1";
    };
    await open(result, "/w/a");

    expect(result.current.output.snapshot("shell-1")).toBe("$ ");
  });

  it("marks a shell that exits before open resolves as exited", async () => {
    const { result } = await setup();
    openImpl = async () => {
      emit({ terminalId: "shell-1", kind: "exit", exitCode: 1 });
      return "shell-1";
    };
    await open(result, "/w/a");

    expect(result.current.tabsFor("/w/a")[0].status).toBe("exited");
  });

  it("marks a tab exited on its exit event", async () => {
    const { result } = await setup();
    await open(result, "/w/a");
    expect(result.current.tabsFor("/w/a")[0].status).toBe("live");

    await emitAct({ terminalId: "shell-1", kind: "exit", exitCode: 0 });

    expect(result.current.tabsFor("/w/a")[0].status).toBe("exited");
  });

  it("appends output once under StrictMode's double listener", async () => {
    const { result } = await setup();
    await open(result, "/w/a");

    await emitAct({ terminalId: "shell-1", kind: "output", data: "hi" });

    expect(result.current.output.snapshot("shell-1")).toBe("hi");
  });

  it("ignores events after it unmounts", async () => {
    const { result, unmount } = await setup();
    await open(result, "/w/a");
    const output = result.current.output;
    unmount();

    emit({ terminalId: "shell-1", kind: "output", data: "late" });

    expect(output.snapshot("shell-1")).toBe("");
  });

  it("ignores events for a closed tab", async () => {
    const { result } = await setup();
    const id = (await open(result, "/w/a")) as unknown as string;
    await emitAct({ terminalId: id, kind: "output", data: "x" });
    act(() => result.current.close(id));

    await emitAct({ terminalId: id, kind: "exit", exitCode: 0 });
    await emitAct({ terminalId: id, kind: "output", data: "late" });

    expect(result.current.output.has(id)).toBe(false);
    expect(result.current.tabsFor("/w/a")).toEqual([]);
    expect(callsTo(invokeSpy, "workspace_terminal_close")[0][1]).toEqual({ id });
  });

  it("drops the tab even when the backend close fails", async () => {
    const { result, onNotice } = await setup();
    closeImpl = () => Promise.reject("ps failed");
    const id = (await open(result, "/w/a")) as unknown as string;

    await act(async () => result.current.close(id));

    expect(result.current.tabsFor("/w/a")).toEqual([]);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("reports a failed open and adds no tab", async () => {
    const { result, onNotice } = await setup();
    openImpl = () => Promise.reject("/w/gone is not one of your workspaces");

    const id = await open(result, "/w/gone");

    expect(id).toBeNull();
    expect(onNotice).toHaveBeenCalledWith("Could not open a terminal: /w/gone is not one of your workspaces");
    expect(result.current.tabsFor("/w/gone")).toEqual([]);
  });

  it("two quick opens make two tabs", async () => {
    const { result } = await setup();
    let ids: (string | null)[] = [];
    await act(async () => {
      ids = await Promise.all([result.current.open("/w/a"), result.current.open("/w/a")]);
    });

    expect(ids[0]).not.toBe(ids[1]);
    expect(result.current.tabsFor("/w/a").map((tab) => [tab.id, tab.number])).toEqual([
      [ids[0], 1],
      [ids[1], 2],
    ]);
  });

  it("keeps each folder's tabs apart", async () => {
    const { result } = await setup();
    await open(result, "/w/a");
    await open(result, "/w/a");
    await open(result, "/w/b");
    expect(result.current.tabsFor("/w/a")).toHaveLength(2);
    expect(result.current.tabsFor("/w/b")).toHaveLength(1);

    act(() => result.current.closeFolder("/w/a"));

    expect(result.current.tabsFor("/w/a")).toEqual([]);
    expect(result.current.tabsFor("/w/b").map((tab) => tab.id)).toEqual(["shell-3"]);
    expect(callsTo(invokeSpy, "workspace_terminal_close").map(([, args]) => args?.id)).toEqual([
      "shell-1",
      "shell-2",
    ]);
  });

  it("sends input and resizes through the existing commands", async () => {
    const { result } = await setup();
    const id = (await open(result, "/w/a")) as unknown as string;

    act(() => {
      result.current.send(id, "ls\r");
      result.current.resize(id, 100, 30);
    });

    expect(callsTo(invokeSpy, "send_input")[0][1]).toEqual({ sessionId: id, data: "ls\r" });
    expect(callsTo(invokeSpy, "resize_session")[0][1]).toEqual({ sessionId: id, cols: 100, rows: 30 });
  });

  it("output does not re-render", async () => {
    const { result, renders } = await setup();
    await open(result, "/w/a");
    const before = renders();

    await act(async () => {
      for (let i = 0; i < 1000; i += 1) emit({ terminalId: "shell-1", kind: "output", data: "line\r\n" });
    });

    expect(renders() - before).toBe(0);
    expect(result.current.output.snapshot("shell-1").length).toBe(6000);
  });
});
