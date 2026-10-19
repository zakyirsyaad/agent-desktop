import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import type { FakeTauriStore } from "./setup";
import { fakeProfiles, makeProfile } from "./fixtures/agents";
import App from "../App";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

const kimi = makeProfile({ id: "kimi", name: "Kimi CLI", source: "registry", transport: "acp", detected: true });
const gemini = makeProfile({ id: "gemini", name: "Gemini CLI", source: "registry", transport: "acp", detected: true });

/** Kimi is enabled; Gemini is ready to run but the user never enabled it. */
async function renderWithRegistryAgents() {
  const settings = fakeStore().state.settings as FakeTauriStore["state"]["settings"] & { enabledAgents?: string[] };
  settings.enabledAgents = ["claude-acp", "kimi"];
  const originalInvoke = tauriInternals().invoke;
  vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
    cmd === "get_agent_profiles"
      ? Promise.resolve([...structuredClone(fakeProfiles), kimi, gemini])
      : originalInvoke(cmd, args),
  );
  await act(async () => {
    render(<App />);
  });
}

const NO_AGENT_NOTICE =
  "No agent is ready. Claude Code, Codex and Qwen Code need Node.js 22 or later, which Zorvo installs for you. Choose one and click Install.";

/** What Install does for an npx agent on a Mac without Node.js 22: Zorvo's Node.js first. */
const NODE_PLAN = [{ kind: "node" as const, name: "Node.js", version: "24.11.1", download_bytes: null }];

/** The default registry agents without Node.js, and no terminal agent found. */
function notReadyProfiles() {
  const needsNode = (id: string, name: string) =>
    makeProfile({
      id,
      name,
      source: "registry",
      transport: "acp",
      distribution: "npx",
      availability: "needs_runtime",
      detected: false,
      install_plan: NODE_PLAN,
    });
  return [
    needsNode("claude-acp", "Claude Code"),
    needsNode("codex-acp", "Codex"),
    needsNode("qwen-code", "Qwen Code"),
    makeProfile({ id: "omp", name: "Oh-My-Pi", detected: false }),
    makeProfile({ id: "aider", name: "Aider", detected: false }),
  ];
}

function newSessionView(): HTMLElement {
  const view = screen.getByRole("heading", { name: "New session" }).parentElement;
  if (!view) throw new Error("the new-session view has no container");
  return view;
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe("Agents in use", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers only the agents in use in the new-session agent picker", async () => {
    await renderWithRegistryAgents();
    await click(screen.getByRole("button", { name: "+ New session" }));

    await click(screen.getByRole("button", { name: "Agent: Claude Code" }));

    const names = screen.getAllByRole("option").map((option) => option.textContent);
    expect(names).toEqual(expect.arrayContaining(["Claude Code", "Kimi CLI", "Oh-My-Pi"]));
    expect(names).not.toContain("Gemini CLI");
    expect(names).not.toContain("Qwen Code");
  });

  it("offers only the agents in use as the default agent in Settings", async () => {
    await renderWithRegistryAgents();

    await click(within(screen.getByRole("complementary")).getByRole("button", { name: "Settings" }));

    const select = within(screen.getByRole("combobox", { name: "Default agent" }));
    const names = select.getAllByRole("option").map((option) => option.textContent);
    expect(names).toEqual(expect.arrayContaining(["Claude Code", "Kimi CLI", "Oh-My-Pi"]));
    expect(names).not.toContain("Gemini CLI");
    expect(names).not.toContain("Qwen Code");
  });

  it("says Node.js is what the default agents need and offers Install when no agent is ready", async () => {
    const notReady = notReadyProfiles();
    const originalInvoke = tauriInternals().invoke;
    const invokeSpy = vi
      .spyOn(tauriInternals(), "invoke")
      .mockImplementation((cmd, args) =>
        cmd === "get_agent_profiles" ? Promise.resolve(notReady) : originalInvoke(cmd, args),
      );
    await act(async () => {
      render(<App />);
    });
    await click(screen.getByRole("button", { name: "+ New session" }));

    expect(newSessionView()).toHaveTextContent(NO_AGENT_NOTICE);
    expect(newSessionView()).not.toHaveTextContent("nodejs.org");
    expect(screen.getByRole("region", { name: "Install Claude Code" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Install" })).toBeDefined();
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    expect(prompt).toBeDisabled();
    await act(async () => {
      fireEvent.change(prompt, { target: { value: "get started" } });
      fireEvent.keyDown(prompt, { key: "Enter" });
    });
    expect(invokeSpy.mock.calls.find(([cmd]) => cmd === "acp_start_session")).toBeUndefined();
  });

  it("names the agents in use that need Node.js when no agent is ready", async () => {
    const settings = fakeStore().state.settings as FakeTauriStore["state"]["settings"] & { enabledAgents?: string[] };
    settings.enabledAgents = ["codex-acp", "kimi"];
    const kimiWithoutNode = makeProfile({
      id: "kimi",
      name: "Kimi CLI",
      source: "registry",
      transport: "acp",
      distribution: "npx",
      availability: "needs_runtime",
      detected: false,
      install_plan: NODE_PLAN,
    });
    const notReady = [...notReadyProfiles(), kimiWithoutNode];
    const originalInvoke = tauriInternals().invoke;
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "get_agent_profiles" ? Promise.resolve(notReady) : originalInvoke(cmd, args),
    );
    await act(async () => {
      render(<App />);
    });

    await click(screen.getByRole("button", { name: "+ New session" }));

    expect(newSessionView()).toHaveTextContent(
      "No agent is ready. Codex and Kimi CLI need Node.js 22 or later, which Zorvo installs for you. Choose one and click Install.",
    );
  });

  it("names the agent to install when no agent in use needs Node.js", async () => {
    const settings = fakeStore().state.settings as FakeTauriStore["state"]["settings"] & { enabledAgents?: string[] };
    settings.enabledAgents = ["opencode"];
    const opencode = makeProfile({
      id: "opencode",
      name: "OpenCode",
      source: "registry",
      transport: "acp",
      distribution: "binary",
      availability: "not_installed",
      detected: false,
      install_plan: [{ kind: "agent", name: "OpenCode", version: "1.19.3", download_bytes: null }],
    });
    const notReady = [...notReadyProfiles(), opencode];
    const originalInvoke = tauriInternals().invoke;
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "get_agent_profiles" ? Promise.resolve(notReady) : originalInvoke(cmd, args),
    );
    await act(async () => {
      render(<App />);
    });

    await click(screen.getByRole("button", { name: "+ New session" }));

    expect(newSessionView()).toHaveTextContent(
      "No agent is ready. OpenCode is not installed yet. Click Install to set it up.",
    );
    expect(screen.getByRole("region", { name: "Install OpenCode" })).toBeDefined();
  });

  it("waits for the agent list before saying no agent is ready", async () => {
    let answer: (profiles: unknown) => void = () => {};
    const originalInvoke = tauriInternals().invoke;
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "get_agent_profiles"
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : originalInvoke(cmd, args),
    );
    await act(async () => {
      render(<App />);
    });
    await click(screen.getByRole("button", { name: "+ New session" }));

    expect(newSessionView()).not.toHaveTextContent("No agent is ready");

    await act(async () => answer(notReadyProfiles()));

    expect(newSessionView()).toHaveTextContent(NO_AGENT_NOTICE);
  });
});
