import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { fakeTauriInvoke, type FakeTauriStore } from "./setup";
import { claudeProfile, fakeProfiles, makeProfile } from "./fixtures/agents";
import type { AgentProfile } from "../types";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener[]>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    return Promise.resolve(() => {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== cb));
    });
  },
  emit: () => Promise.resolve(),
}));

import App from "../App";
import { AgentInstallPanel } from "../components/AgentInstallPanel";
import { forgetFailedInstalls, installEntryOf, resetAgentInstalls, startInstall } from "../lib/agent-installs";

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

async function deliver(event: string, payload: unknown) {
  await act(async () => {
    (listeners.get(event) ?? []).forEach((cb) => cb({ payload }));
  });
}

const MB = 1_048_576;

/** A registry agent that needs Zorvo's Node.js before it can run. */
const codex = makeProfile({
  id: "codex-acp",
  name: "Codex",
  source: "registry",
  detected: false,
  availability: "needs_runtime",
  distribution: "npx",
  install_plan: [
    { kind: "node", name: "Node.js", version: "24.11.1", download_bytes: 49 * MB },
    { kind: "agent", name: "Codex", version: "0.4.2", download_bytes: null },
  ],
});

type Settle = { resolve: () => void; reject: (error: string) => void };

/**
 * Answers each agent's `install_agent` with a promise the test settles, `get_agent_profiles`
 * with `profiles` when given (read on every call), and the rest as the fake backend does.
 */
function mockInstall(profiles?: AgentProfile[]) {
  const pending = new Map<string, Settle>();
  const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) => {
    if (cmd === "get_agent_profiles" && profiles) return Promise.resolve(structuredClone(profiles));
    if (cmd === "install_agent") {
      return new Promise<void>((resolve, reject) => {
        pending.set(String(args?.agentId), { resolve, reject });
      });
    }
    return fakeTauriInvoke(cmd, args);
  });
  const settle = (agentId = "codex-acp"): Settle => {
    const found = pending.get(agentId);
    if (!found) throw new Error(`No install of ${agentId} is pending`);
    return found;
  };
  return { spy, settle };
}

const opencode = makeProfile({
  ...codex,
  id: "opencode",
  name: "OpenCode",
  install_plan: [{ kind: "agent", name: "OpenCode", version: "1.19.3", download_bytes: null }],
});

const nodeDownload = {
  agentId: "codex-acp",
  stepIndex: 0,
  stepCount: 2,
  kind: "node",
  name: "Node.js",
  phase: "download",
  receivedBytes: 256,
  totalBytes: 1024,
};

function renderPanel(agent = codex) {
  return act(async () => render(<AgentInstallPanel agent={agent} />));
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe("Installing an agent from the new-session draft", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentInstalls();
    listeners.clear();
  });

  it("lists_the_plan_and_installs_on_click", async () => {
    const { spy } = mockInstall();
    await renderPanel();

    expect(screen.getByRole("region", { name: "Install Codex" })).toBeDefined();
    expect(screen.getByText("Codex needs Node.js 24.11.1 (49 MB) and Codex 0.4.2 before it can start.")).toBeDefined();

    await click("Install");

    expect(callsTo(spy, "install_agent").map(([, args]) => args)).toEqual([{ agentId: "codex-acp" }]);
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("shows_progress_from_events", async () => {
    mockInstall();
    await renderPanel();
    await click("Install");

    await deliver("agent-install-progress", {
      agentId: "codex-acp",
      stepIndex: 0,
      stepCount: 2,
      kind: "node",
      name: "Node.js",
      phase: "download",
      receivedBytes: 512,
      totalBytes: 1024,
    });

    const bar = screen.getByRole("progressbar", { name: "Node.js download" }) as HTMLProgressElement;
    expect(bar.value / bar.max).toBe(0.5);
    expect(screen.getByText("Downloading Node.js…")).toBeDefined();

    // Another agent's progress is not this one's.
    await deliver("agent-install-progress", {
      agentId: "qwen-code",
      stepIndex: 0,
      stepCount: 1,
      kind: "prerequisite",
      name: "pi",
      phase: "npm",
      receivedBytes: 0,
      totalBytes: null,
    });
    expect(screen.queryByText("Installing pi with npm…")).toBeNull();

    await deliver("agent-install-progress", {
      agentId: "codex-acp",
      stepIndex: 1,
      stepCount: 2,
      kind: "agent",
      name: "Codex",
      phase: "npm",
      receivedBytes: 0,
      totalBytes: null,
    });
    const indeterminate = screen.getByRole("progressbar", { name: "Codex download" });
    expect(indeterminate.hasAttribute("value")).toBe(false);
    expect(screen.getByText("Installing Codex with npm…")).toBeDefined();
  });

  it("cancel_calls_cancel_agent_install_and_returns_to_install", async () => {
    const { spy, settle } = mockInstall();
    await renderPanel();
    await click("Install");

    await click("Cancel");
    expect(callsTo(spy, "cancel_agent_install").map(([, args]) => args)).toEqual([{ agentId: "codex-acp" }]);

    await act(async () => settle().reject("INSTALL_CANCELLED"));

    expect(screen.getByRole("button", { name: "Install" })).toBeDefined();
    expect(screen.queryByText(/INSTALL_CANCELLED/)).toBeNull();
  });

  it("a_failure_shows_the_message_and_retry_installs_again", async () => {
    const { spy, settle } = mockInstall();
    await renderPanel();
    await click("Install");

    await act(async () => settle().reject("Not enough disk space to install Node.js"));

    expect(screen.getByText(/Not enough disk space to install Node\.js/)).toBeDefined();
    await click("Retry");
    expect(callsTo(spy, "install_agent")).toHaveLength(2);
    expect(screen.queryByText(/Not enough disk space/)).toBeNull();
  });

  it("keeps an install's result for its own agent when the user switches away and back", async () => {
    const { spy, settle } = mockInstall();
    const { rerender } = await renderPanel();
    await click("Install");

    await act(async () => rerender(<AgentInstallPanel agent={opencode} />));
    // OpenCode has its own state: not installing, and Codex's answer is not its own.
    expect(screen.getByRole("button", { name: "Install" })).toBeDefined();
    await act(async () => settle().reject("Codex failed"));
    expect(screen.queryByText(/Codex failed/)).toBeNull();

    await act(async () => rerender(<AgentInstallPanel agent={codex} />));
    expect(screen.getByText("Install failed: Codex failed")).toBeDefined();
    await click("Retry");
    expect(callsTo(spy, "install_agent").map(([, args]) => args)).toEqual([
      { agentId: "codex-acp" },
      { agentId: "codex-acp" },
    ]);
  });

  it("shows a running install's progress and result after the panel unmounts and comes back", async () => {
    const { spy, settle } = mockInstall();
    const { unmount } = await renderPanel();
    await click("Install");
    // Picking a ready agent removes the panel; the install goes on.
    unmount();
    await deliver("agent-install-progress", nodeDownload);

    await renderPanel();
    const bar = screen.getByRole("progressbar", { name: "Node.js download" }) as HTMLProgressElement;
    expect(bar.value / bar.max).toBe(0.25);
    expect(screen.getByText("Downloading Node.js…")).toBeDefined();

    await act(async () => settle().reject("Checksum mismatch for Node.js"));
    expect(screen.getByText("Install failed: Checksum mismatch for Node.js")).toBeDefined();
    expect(callsTo(spy, "install_agent")).toHaveLength(1);
  });

  it("offers no second Install while an agent is installing, even after coming back to it", async () => {
    const { spy, settle } = mockInstall();
    const { unmount } = await renderPanel();
    await click("Install");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    unmount();
    await renderPanel();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
    expect(callsTo(spy, "install_agent")).toHaveLength(1);

    await act(async () => settle().resolve());
    expect(screen.getByRole("button", { name: "Install" })).toBeDefined();
  });

  it("with no ready agent in use, the draft offers the picker and Install", async () => {
    // A new Mac without Node.js: every default agent needs Zorvo's Node first.
    const claude = makeProfile({
      ...claudeProfile,
      detected: false,
      detected_path: null,
      availability: "needs_runtime",
      distribution: "npx",
      install_plan: [
        { kind: "node", name: "Node.js", version: "24.11.1", download_bytes: 49 * MB },
        { kind: "agent", name: "Claude Code", version: "0.9.0", download_bytes: null },
      ],
    });
    const profiles: AgentProfile[] = [claude, codex];
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "get_agent_profiles" ? Promise.resolve(structuredClone(profiles)) : fakeTauriInvoke(cmd, args)
    );
    await act(async () => {
      render(<App />);
    });

    await waitFor(() => expect(screen.getByRole("region", { name: "Install Claude Code" })).toBeDefined());
    expect(screen.getByRole("button", { name: "Install" })).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Agent:/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Codex (not installed)" }));
    });
    expect(screen.getByRole("region", { name: "Install Codex" })).toBeDefined();
  });

  it("offers Install over an ended chat whose agent is not installed", async () => {
    const endedChat = (id: string, name: string, profileId: string) => ({
      id,
      name,
      profileId,
      cwd: "/Users/test/developer/ai-perpetual-trading",
      status: "terminated",
      createdAt: 1,
      transport: "acp",
    });
    fakeStore().state.sessions = [endedChat("s-codex", "Codex chat", "codex-acp")];
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "get_agent_profiles"
        ? Promise.resolve([...structuredClone(fakeProfiles), structuredClone(codex)])
        : fakeTauriInvoke(cmd, args)
    );
    await act(async () => {
      render(<App />);
    });
    await waitFor(() => expect(screen.getAllByText("Codex chat").length).toBeGreaterThan(0));
    await act(async () => {
      fireEvent.click(screen.getAllByText("Codex chat")[0]);
    });

    expect(screen.getByRole("region", { name: "Install Codex" })).toBeDefined();
  });

  it("shows no Install panel over an ended chat whose agent is ready", async () => {
    fakeStore().state.sessions = [
      {
        id: "s-qwen",
        name: "Qwen chat",
        profileId: "qwen-code",
        cwd: "/Users/test/developer/ai-perpetual-trading",
        status: "terminated",
        createdAt: 1,
        transport: "acp",
      },
    ];
    // Codex, not installed, is the new-session draft's agent; the ended chat is not a draft.
    fakeStore().state.settings.defaultAgentId = "codex-acp";
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "get_agent_profiles"
        ? Promise.resolve([...structuredClone(fakeProfiles), structuredClone(codex)])
        : fakeTauriInvoke(cmd, args)
    );
    await act(async () => {
      render(<App />);
    });
    await waitFor(() => expect(screen.getAllByText("Qwen chat").length).toBeGreaterThan(0));
    await act(async () => {
      fireEvent.click(screen.getAllByText("Qwen chat")[0]);
    });

    expect(screen.queryByRole("region", { name: /^Install / })).toBeNull();
  });

  it("a_not_ready_agent_in_use_is_offered_in_the_picker_and_shows_the_panel", async () => {
    fakeStore().state.settings.defaultAgentId = "qwen-code";
    const profiles: AgentProfile[] = [...structuredClone(fakeProfiles), codex];
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "get_agent_profiles" ? Promise.resolve(structuredClone(profiles)) : fakeTauriInvoke(cmd, args)
    );
    const probedAgents = () => callsTo(spy, "acp_probe_agent").map(([, args]) => args?.profileId);
    await act(async () => {
      render(<App />);
    });
    // The default agent, ready and ACP, is asked what it offers.
    await waitFor(() => expect(probedAgents()).toEqual(["qwen-code"]));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Agent:/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Codex (not installed)" }));
    });

    expect(screen.getByRole("region", { name: "Install Codex" })).toBeDefined();
    // Only Send waits for the install: the prompt can be written meanwhile.
    const promptBox = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
    expect(promptBox.disabled).toBe(false);
    expect(promptBox.placeholder).toBe("Install Codex to start a session.");
    await act(async () => {
      fireEvent.change(promptBox, { target: { value: "hello" } });
    });
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    // Codex is not installed, so there is nothing to ask yet.
    expect(probedAgents()).toEqual(["qwen-code"]);

    // Installed: the backend reports Codex ready and says the profiles changed.
    profiles[profiles.length - 1] = { ...codex, availability: "ready", detected: true, install_plan: null };
    await deliver("agent-profiles-changed", null);

    await waitFor(() => expect(probedAgents()).toEqual(["qwen-code", "codex-acp"]));
    expect(screen.queryByRole("region", { name: "Install Codex" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Agent: Codex$/ })).toBeDefined();
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("forgets only failed installs, and only of the agents named ready", async () => {
    const { settle } = mockInstall();
    await act(async () => {
      startInstall("codex-acp");
      startInstall("opencode");
    });
    await act(async () => settle("opencode").reject("Checksum mismatch for OpenCode"));

    // A profiles reload mid-install names Codex ready: its live install stays.
    forgetFailedInstalls(["codex-acp"]);
    expect(installEntryOf("codex-acp").status).toBe("installing");
    // OpenCode is not named, so its failure stays until it is ready.
    expect(installEntryOf("opencode").status).toBe("failed");

    forgetFailedInstalls(["opencode"]);
    expect(installEntryOf("opencode").status).toBe("idle");
    expect(installEntryOf("opencode").error).toBeNull();
  });

  it("forgets a failed install once the agent is ready, so a later missing agent offers Install again", async () => {
    const profiles: AgentProfile[] = [...structuredClone(fakeProfiles), codex];
    const { settle } = mockInstall(profiles);
    await act(async () => {
      render(<App />);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Agent:/ })).toBeDefined());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Agent:/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Codex (not installed)" }));
    });
    await click("Install");
    await act(async () => settle().reject("Checksum mismatch for Node.js"));
    expect(screen.getByText("Install failed: Checksum mismatch for Node.js")).toBeDefined();

    // Installed some other way: Codex is ready.
    profiles[profiles.length - 1] = { ...codex, availability: "ready", detected: true, install_plan: null };
    await deliver("agent-profiles-changed", null);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Install Codex" })).toBeNull());

    // Later removed again: the panel starts over instead of showing the old failure.
    profiles[profiles.length - 1] = codex;
    await deliver("agent-profiles-changed", null);
    await waitFor(() => expect(screen.getByRole("region", { name: "Install Codex" })).toBeDefined());
    expect(screen.getByRole("button", { name: "Install" })).toBeDefined();
    expect(screen.queryByText(/Checksum mismatch/)).toBeNull();
  });
});
