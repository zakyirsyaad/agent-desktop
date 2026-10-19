import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { fakeTauriInvoke } from "./setup";
import { makeProfile } from "./fixtures/agents";

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
import { AgentInstallPanel } from "../components/AgentInstallPanel";

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

  it("a Cancel clicked while the listener attaches stops the install before it starts", async () => {
    const codex = makeProfile({
      id: "codex-acp",
      name: "Codex",
      source: "registry",
      transport: "acp",
      detected: false,
      install_plan: [{ kind: "agent", name: "Codex", version: "0.4.2", download_bytes: null }],
    });
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "install_agent" || cmd === "cancel_agent_install"
        ? Promise.resolve(cmd === "cancel_agent_install" ? false : undefined)
        : fakeTauriInvoke(cmd, args)
    );
    const calls = (cmd: string) => spy.mock.calls.filter(([name]) => name === cmd);
    await act(async () => {
      render(createElement(AgentInstallPanel, { agent: codex }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    await act(async () => {
      waiting.splice(0).forEach((resolve) => resolve());
    });

    expect(calls("install_agent")).toEqual([]);
    expect(screen.getByRole("button", { name: "Install" })).toBeDefined();
    expect(screen.queryByText(/failed|Could not/)).toBeNull();
    expect(installEntryOf("codex-acp").status).toBe("idle");
  });
});
