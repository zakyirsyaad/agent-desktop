import { describe, it, expect, vi, afterEach } from "vitest";
import { fakeTauriInvoke } from "./setup";

type Listener = (event: { payload: unknown }) => void;

/** Listeners Tauri delivers to: one is added only once its `listen` resolves, as in the app. */
const active = new Map<string, Listener[]>();
/** `listen` calls the test has not let resolve yet. */
const waiting: Array<() => void> = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) =>
    new Promise((resolve) => {
      waiting.push(() => {
        active.set(event, [...(active.get(event) ?? []), cb]);
        resolve(() => {
          active.set(event, (active.get(event) ?? []).filter((l) => l !== cb));
        });
      });
    }),
  emit: () => Promise.resolve(),
}));

import { installEntryOf, resetAgentInstalls, startInstall } from "../lib/agent-installs";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function deliver(event: string, payload: unknown) {
  (active.get(event) ?? []).forEach((cb) => cb({ payload }));
}

const firstProgress = {
  agentId: "codex-acp",
  stepIndex: 0,
  stepCount: 2,
  kind: "node",
  name: "Node.js",
  phase: "download",
  receivedBytes: 0,
  totalBytes: 1024,
};

describe("agent installs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentInstalls();
    waiting.splice(0).forEach((resolve) => resolve());
    active.clear();
  });

  it("starts the install only once the progress listener is attached, so its first event is shown", async () => {
    const installs: string[] = [];
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) => {
      if (cmd === "install_agent") {
        installs.push(String(args?.agentId));
        // The backend reports its first phase at once.
        deliver("agent-install-progress", firstProgress);
        return new Promise(() => {});
      }
      return fakeTauriInvoke(cmd, args);
    });

    startInstall("codex-acp");

    expect(installEntryOf("codex-acp").status).toBe("installing");
    await Promise.resolve();
    expect(installs).toEqual([]);

    waiting.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(installs).toEqual(["codex-acp"]));
    expect(installEntryOf("codex-acp").progress).toEqual(firstProgress);
  });
});
