import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { fakeTauriInvoke, type FakeTauriStore } from "./setup";
import { fakeCatalog, makeCatalogAgent } from "./fixtures/catalog";
import { fakeProfiles, makeProfile } from "./fixtures/agents";
import type { AgentCatalog as Catalog, Settings } from "../types";

type Listener = (event: { payload: unknown }) => void;
const { listeners } = vi.hoisted(() => ({ listeners: new Map<string, Listener>() }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
  emit: () => Promise.resolve(),
}));

import App from "../App";
import { AgentCatalog } from "../components/agents/AgentCatalog";
import { AppSettingsDialog } from "../components/AppSettingsDialog";
import { useAgentCatalogActions, type AgentCatalogActions } from "../hooks/useAgentCatalogActions";
import { useAgentCatalog } from "../hooks/useAgentCatalog";
import { useAgentProfiles } from "../hooks/useDiscovery";
import { usePersistedState } from "../hooks/usePersistedState";
import { resetAgentInstalls } from "../lib/agent-installs";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
type InvokeCall = [string, Record<string, unknown> | undefined];
type Override = (cmd: string, args: Record<string, unknown> | undefined) => Promise<unknown> | undefined;

const internals = () => (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
const fakeStore = () => (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
const savedSettings = () => fakeStore().state.settings as unknown as Settings;

/** Spies on the backend; `override` answers the commands it cares about, the fake backend the rest. */
function spyOnBackend(override: Override = () => undefined) {
  return vi
    .spyOn(internals(), "invoke")
    .mockImplementation((cmd, args) => override(cmd, args) ?? fakeTauriInvoke(cmd, args));
}

/** The calls to `cmd`, each as its name and arguments. */
function callsTo(spy: { mock: { calls: unknown[][] } }, cmd: string): InvokeCall[] {
  return (spy.mock.calls as unknown as InvokeCall[])
    .filter(([name]) => name === cmd)
    .map(([name, args]) => [name, args]);
}

afterEach(() => {
  vi.restoreAllMocks();
  listeners.clear();
  resetAgentInstalls();
});

const NO_ACTIONS: AgentCatalogActions = {
  addAgent: () => {},
  updateAgent: () => {},
  removeAgent: () => Promise.resolve(),
  runningSessionCount: () => 0,
};

function renderCatalog(overrides: Partial<Parameters<typeof AgentCatalog>[0]> = {}) {
  const props = {
    catalog: { lastChecked: null, agents: fakeCatalog } as Catalog | null,
    error: null,
    agents: fakeProfiles,
    enabledIds: ["claude-acp", "codex-acp", "qwen-code"],
    actions: NO_ACTIONS,
    onCheckAgain: () => Promise.resolve(),
    onRetryLoad: vi.fn(),
    ...overrides,
  };
  render(<AgentCatalog {...props} />);
  return props;
}

const row = (name: string) => screen.getByRole("listitem", { name });
const section = (name: RegExp) => screen.getByRole("region", { name });

describe("AgentCatalog", () => {
  it("lists the agents in use and all the others in two sections", () => {
    renderCatalog();

    expect(within(section(/^In use \(3\)$/)).getAllByRole("listitem").map((item) => item.getAttribute("aria-label")))
      .toEqual(["Claude Code", "Codex", "Qwen Code"]);
    expect(within(section(/^All agents \(1\)$/)).getByRole("listitem", { name: "Gemini CLI" })).toBeInTheDocument();
  });

  it("shows each agent's version, status line and description", () => {
    renderCatalog();

    expect(row("Claude Code")).toHaveTextContent("1.2.0");
    expect(row("Claude Code")).toHaveTextContent("Installed by Zorvo");
    expect(row("Qwen Code")).toHaveTextContent("Runs with npx");
    expect(row("Gemini CLI")).toHaveTextContent("Google's coding agent");
  });

  it("hides the registry version of a program managed outside Zorvo, which may not be the one you run", () => {
    renderCatalog({
      catalog: {
        lastChecked: null,
        agents: [
          makeCatalogAgent({
            id: "opencode",
            name: "OpenCode",
            version: "1.19.3",
            status: "on_your_mac",
            distribution: "binary",
            location: "/opt/homebrew/bin/opencode",
          }),
          makeCatalogAgent({ id: "goose", name: "Goose", version: "2.0.0", status: "on_your_mac", location: null }),
        ],
      },
      enabledIds: [],
    });

    expect(row("OpenCode")).toHaveTextContent("Managed outside Zorvo · /opt/homebrew/bin/opencode");
    expect(row("OpenCode")).not.toHaveTextContent("1.19.3");
    expect(row("Goose")).toHaveTextContent("2.0.0");
  });

  it("filters the rows by the search and says when nothing matches", () => {
    renderCatalog();
    const search = screen.getByRole("searchbox", { name: "Search agents" });

    fireEvent.change(search, { target: { value: "google" } });
    expect(screen.getAllByRole("listitem").map((item) => item.getAttribute("aria-label"))).toEqual(["Gemini CLI"]);

    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText('No agents match "zzz".')).toBeInTheDocument();
  });

  it("says when the registry was last checked", () => {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 3600;
    renderCatalog({ catalog: { lastChecked: twoHoursAgo, agents: fakeCatalog } });

    expect(screen.getByText("Registry checked 2 hours ago")).toBeInTheDocument();
  });

  it("ages the checked time while the panel stays open", () => {
    vi.useFakeTimers();
    try {
      const now = Math.floor(Date.now() / 1000);
      const baseline = vi.getTimerCount();
      renderCatalog({ catalog: { lastChecked: now - 30, agents: fakeCatalog } });
      expect(screen.getByText("Registry checked just now")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(screen.getByText("Registry checked 1 minute ago")).toBeInTheDocument();

      cleanup();
      expect(vi.getTimerCount()).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing about the registry before it was ever checked", () => {
    renderCatalog();

    expect(screen.queryByText(/Registry checked/)).toBeNull();
  });

  it("shows a load error with Try again", () => {
    const props = renderCatalog({ catalog: null, error: "boom" });

    expect(screen.getByText("Could not load the agents: boom")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(props.onRetryLoad).toHaveBeenCalledTimes(1);
  });

  it("checks again, and says so in the catalog when the check failed", async () => {
    let fail: (error: Error) => void = () => {};
    const onCheckAgain = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    renderCatalog({ onCheckAgain });

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Check again" })).toBeDisabled();

    await act(async () => fail(new Error("no shell")));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't check your agents. Try again.");
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("offers Update only for an agent in use that has a newer version", () => {
    renderCatalog();

    expect(within(row("Claude Code")).getByRole("button", { name: "Update to 1.3.0" })).toBeInTheDocument();
    expect(within(row("Codex")).queryByRole("button", { name: /Update/ })).toBeNull();
    expect(within(row("Gemini CLI")).getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(within(row("Gemini CLI")).queryByRole("button", { name: "Remove" })).toBeNull();
  });
});

/** The Settings dialog with the app's real state, profile and catalog hooks behind it. */
function Harness() {
  const persisted = usePersistedState(() => {});
  const { agents, refresh, reload } = useAgentProfiles(() => {});
  const catalog = useAgentCatalog();
  const actions = useAgentCatalogActions({
    updateState: persisted.updateState,
    saveNow: persisted.saveNow,
    agents,
    sessions: persisted.state.sessions,
    stopSession: () => Promise.resolve(true),
    reloadAgents: reload,
    catalog,
  });
  return (
    <AppSettingsDialog
      isOpen
      persisted={persisted}
      agents={agents}
      refreshAgents={refresh}
      catalog={catalog}
      actions={actions}
      recentFolders={[]}
      onRemoveRecentFolder={() => {}}
      onRunOnboarding={() => {}}
      onClose={() => {}}
    />
  );
}

const geminiProfile = makeProfile({
  id: "gemini",
  name: "Gemini CLI",
  source: "registry",
  transport: "acp",
  availability: "not_installed",
  install_plan: [{ kind: "agent", name: "Gemini CLI", version: "0.2.0", download_bytes: null }],
});

/** The profiles with Gemini CLI, not installed, among them. */
const withGemini: Override = (cmd) =>
  cmd === "get_agent_profiles" ? Promise.resolve([...structuredClone(fakeProfiles), geminiProfile]) : undefined;

async function openAgentsTab() {
  await act(async () => {
    render(<Harness />);
  });
  fireEvent.click(screen.getByRole("tab", { name: /Agents/ }));
  await screen.findByRole("listitem", { name: "Gemini CLI" });
}

describe("Catalog actions — Add", () => {
  it("adds a ready agent without installing anything", async () => {
    (fakeStore().state.settings as Partial<Settings>).enabledAgents = ["claude-acp", "codex-acp"];
    const spy = spyOnBackend(withGemini);
    await openAgentsTab();

    fireEvent.click(within(row("Qwen Code")).getByRole("button", { name: "Add" }));

    expect(within(section(/^In use/)).getByRole("listitem", { name: "Qwen Code" })).toBeInTheDocument();
    await waitFor(() => expect(savedSettings().enabledAgents).toEqual(["claude-acp", "codex-acp", "qwen-code"]));
    expect(callsTo(spy, "install_agent")).toHaveLength(0);
  });

  it("records the catalog's version of the agent in the same save as the Add", async () => {
    (fakeStore().state.settings as Partial<Settings>).enabledAgents = ["claude-acp", "codex-acp"];
    (fakeStore().state.settings as Partial<Settings>).agentVersions = { "claude-acp": "1.2.0" };
    spyOnBackend(withGemini);
    await openAgentsTab();

    fireEvent.click(within(row("Qwen Code")).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(savedSettings().enabledAgents).toContain("qwen-code"));
    expect(savedSettings().agentVersions).toEqual({ "claude-acp": "1.2.0", "qwen-code": "0.4.0" });
  });

  it("installs an agent that is not installed, with progress and Cancel in its row", async () => {
    const spy = spyOnBackend((cmd, args) =>
      cmd === "install_agent" ? new Promise(() => {}) : withGemini(cmd, args),
    );
    await openAgentsTab();

    await act(async () => {
      fireEvent.click(within(row("Gemini CLI")).getByRole("button", { name: "Add" }));
    });

    await waitFor(() => expect(callsTo(spy, "install_agent")).toEqual([["install_agent", { agentId: "gemini" }]]));
    expect(within(row("Gemini CLI")).getByText("Starting the install…")).toBeInTheDocument();
    expect(within(row("Gemini CLI")).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await waitFor(() => expect(savedSettings().enabledAgents).toContain("gemini"));
  });

  it("keeps a failed install's agent in use and offers Retry", async () => {
    spyOnBackend((cmd, args) =>
      cmd === "install_agent" ? Promise.reject("network down") : withGemini(cmd, args),
    );
    await openAgentsTab();

    await act(async () => {
      fireEvent.click(within(row("Gemini CLI")).getByRole("button", { name: "Add" }));
    });

    expect(await within(row("Gemini CLI")).findByText("Install failed: network down")).toBeInTheDocument();
    expect(within(row("Gemini CLI")).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(within(section(/^In use/)).getByRole("listitem", { name: "Gemini CLI" })).toBeInTheDocument();
  });
});

describe("Catalog actions — Install", () => {
  it("offers Install for an agent in use that is not installed, with progress, Cancel and Retry", async () => {
    (fakeStore().state.settings as Partial<Settings>).enabledAgents = ["claude-acp", "gemini"];
    let failInstall: (reason: string) => void = () => {};
    const spy = spyOnBackend((cmd, args) =>
      cmd === "install_agent" ? new Promise((_, reject) => (failInstall = reject)) : withGemini(cmd, args),
    );
    await openAgentsTab();
    const gemini = () => within(section(/^In use/)).getByRole("listitem", { name: "Gemini CLI" });
    expect(gemini()).toHaveTextContent("Not installed · Install adds Gemini CLI 0.2.0");
    expect(within(gemini()).queryByRole("button", { name: "Add" })).toBeNull();

    await act(async () => {
      fireEvent.click(within(gemini()).getByRole("button", { name: "Install" }));
    });

    await waitFor(() => expect(callsTo(spy, "install_agent")).toEqual([["install_agent", { agentId: "gemini" }]]));
    expect(within(gemini()).getByText("Starting the install…")).toBeInTheDocument();
    expect(within(gemini()).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(gemini()).queryByRole("button", { name: "Install" })).toBeNull();

    await act(async () => failInstall("network down"));

    expect(await within(gemini()).findByText("Install failed: network down")).toBeInTheDocument();
    expect(within(gemini()).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(within(gemini()).queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("installs on Add when the catalog says the agent is not installed, though its profile says ready", async () => {
    const readyGemini = { ...geminiProfile, availability: "ready" as const };
    const spy = spyOnBackend((cmd) => {
      if (cmd === "install_agent") return new Promise(() => {});
      if (cmd === "get_agent_profiles") return Promise.resolve([...structuredClone(fakeProfiles), readyGemini]);
      return undefined;
    });
    await openAgentsTab();

    await act(async () => {
      fireEvent.click(within(row("Gemini CLI")).getByRole("button", { name: "Add" }));
    });

    await waitFor(() => expect(callsTo(spy, "install_agent")).toEqual([["install_agent", { agentId: "gemini" }]]));
  });
});

describe("Catalog actions — Update", () => {
  const catalogWithUpdate: Catalog = {
    lastChecked: null,
    agents: [
      makeCatalogAgent({ id: "claude-acp", name: "Claude Code", version: "1.0.0", updateVersion: "1.1.0", status: "by_zorvo" }),
      ...fakeCatalog.filter((agent) => agent.id !== "claude-acp"),
    ],
  };

  it("updates the agent, records and saves its version, then reloads profiles and catalog", async () => {
    const spy = spyOnBackend((cmd, args) => {
      if (cmd === "get_agent_catalog") return Promise.resolve(structuredClone(catalogWithUpdate));
      if (cmd === "update_agent") return Promise.resolve("1.1.0");
      return withGemini(cmd, args);
    });
    await openAgentsTab();
    const catalogLoads = callsTo(spy, "get_agent_catalog").length;
    const profileLoads = callsTo(spy, "get_agent_profiles").length;

    await act(async () => {
      fireEvent.click(within(row("Claude Code")).getByRole("button", { name: "Update to 1.1.0" }));
    });

    await waitFor(() => expect(callsTo(spy, "update_agent")).toEqual([["update_agent", { agentId: "claude-acp" }]]));
    await waitFor(() => expect(savedSettings().agentVersions?.["claude-acp"]).toBe("1.1.0"));
    expect(callsTo(spy, "save_app_state").length).toBeGreaterThan(0);
    await waitFor(() => expect(callsTo(spy, "get_agent_profiles").length).toBeGreaterThan(profileLoads));
    // A plain reload: no registry fetch, npm scan or login-shell read, which only Check again does.
    expect(callsTo(spy, "get_agent_profiles").slice(profileLoads).map(([, args]) => args?.refresh)).toEqual([false]);
    expect(callsTo(spy, "get_agent_catalog").length).toBeGreaterThan(catalogLoads);
  });

  it("saves the new version before the profiles are read again", async () => {
    let savedWhenReloaded: Settings | null = null;
    let isUpdated = false;
    spyOnBackend((cmd, args) => {
      if (cmd === "get_agent_catalog") return Promise.resolve(structuredClone(catalogWithUpdate));
      if (cmd === "update_agent") {
        isUpdated = true;
        return Promise.resolve("1.1.0");
      }
      if (cmd === "get_agent_profiles" && isUpdated && savedWhenReloaded === null) {
        savedWhenReloaded = structuredClone(savedSettings());
      }
      return withGemini(cmd, args);
    });
    await openAgentsTab();

    await act(async () => {
      fireEvent.click(within(row("Claude Code")).getByRole("button", { name: "Update to 1.1.0" }));
    });

    await waitFor(() => expect(savedWhenReloaded?.agentVersions?.["claude-acp"]).toBe("1.1.0"));
  });

  it("says so in the row, and reads nothing again, when the new version could not be saved", async () => {
    let isUpdated = false;
    const spy = spyOnBackend((cmd, args) => {
      if (cmd === "get_agent_catalog") return Promise.resolve(structuredClone(catalogWithUpdate));
      if (cmd === "update_agent") {
        isUpdated = true;
        return Promise.resolve("1.1.0");
      }
      if (cmd === "save_app_state" && isUpdated) return Promise.reject("disk full");
      return withGemini(cmd, args);
    });
    await openAgentsTab();
    const profileLoads = callsTo(spy, "get_agent_profiles").length;

    await act(async () => {
      fireEvent.click(within(row("Claude Code")).getByRole("button", { name: "Update to 1.1.0" }));
    });

    expect(await within(row("Claude Code")).findByText("Update failed: Could not save version 1.1.0: disk full"))
      .toBeInTheDocument();
    expect(within(row("Claude Code")).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(callsTo(spy, "get_agent_profiles")).toHaveLength(profileLoads);
  });

  it("reloads the catalog after a refused update and says it failed", async () => {
    const spy = spyOnBackend((cmd, args) => {
      if (cmd === "get_agent_catalog") return Promise.resolve(structuredClone(catalogWithUpdate));
      if (cmd === "update_agent") return Promise.reject("no update");
      return withGemini(cmd, args);
    });
    await openAgentsTab();
    const catalogLoads = callsTo(spy, "get_agent_catalog").length;

    await act(async () => {
      fireEvent.click(within(row("Claude Code")).getByRole("button", { name: "Update to 1.1.0" }));
    });

    expect(await within(row("Claude Code")).findByText("Update failed: no update")).toBeInTheDocument();
    await waitFor(() => expect(callsTo(spy, "get_agent_catalog").length).toBeGreaterThan(catalogLoads));
  });
});

describe("Catalog actions — Remove", () => {
  async function removeFromRow(name: string) {
    fireEvent.click(within(row(name)).getByRole("button", { name: "Remove" }));
    await act(async () => {
      fireEvent.click(within(row(name)).getByRole("button", { name: "Remove" }));
    });
  }

  it("asks in the row first, and Cancel keeps the agent", async () => {
    spyOnBackend(withGemini);
    await openAgentsTab();

    fireEvent.click(within(row("Codex")).getByRole("button", { name: "Remove" }));
    expect(within(row("Codex")).getByText("Remove Codex? Zorvo deletes its copy. Saved sessions stay readable."))
      .toBeInTheDocument();
    fireEvent.click(within(row("Codex")).getByRole("button", { name: "Cancel" }));

    expect(within(row("Codex")).queryByText(/Zorvo deletes its copy/)).toBeNull();
    expect(within(section(/^In use/)).getByRole("listitem", { name: "Codex" })).toBeInTheDocument();
  });

  it("disables the agent, remembers the removal and deletes Zorvo's copy", async () => {
    const spy = spyOnBackend(withGemini);
    await openAgentsTab();

    await removeFromRow("Codex");

    await waitFor(() => expect(callsTo(spy, "remove_agent_install")).toEqual([["remove_agent_install", { agentId: "codex-acp" }]]));
    expect(savedSettings().enabledAgents).toEqual(["claude-acp", "qwen-code"]);
    expect(savedSettings().removedAgents).toEqual(["codex-acp"]);
    expect(within(section(/^All agents/)).getByRole("listitem", { name: "Codex" })).toBeInTheDocument();
  });

  it("saves the removal before the backend deletes the copy", async () => {
    let savedWhenRemoved: Settings | null = null;
    spyOnBackend((cmd, args) => {
      if (cmd === "remove_agent_install") savedWhenRemoved = structuredClone(savedSettings());
      return withGemini(cmd, args);
    });
    await openAgentsTab();

    await removeFromRow("Codex");

    await waitFor(() => expect(savedWhenRemoved?.enabledAgents).toEqual(["claude-acp", "qwen-code"]));
  });

  it("keeps the agent disabled and says so when the copy could not be deleted", async () => {
    spyOnBackend((cmd, args) =>
      cmd === "remove_agent_install" ? Promise.reject("busy") : withGemini(cmd, args),
    );
    await openAgentsTab();

    await removeFromRow("Codex");

    expect(await within(row("Codex")).findByText("Could not delete Zorvo's copy: busy")).toBeInTheDocument();
    expect(within(section(/^All agents/)).getByRole("listitem", { name: "Codex" })).toBeInTheDocument();
    await waitFor(() => expect(savedSettings().enabledAgents).toEqual(["claude-acp", "qwen-code"]));
  });

  it("deletes nothing and says so when the removal could not be saved", async () => {
    const spy = spyOnBackend((cmd, args) =>
      cmd === "save_app_state" ? Promise.reject("disk full") : withGemini(cmd, args),
    );
    await openAgentsTab();

    await removeFromRow("Codex");

    expect(await within(row("Codex")).findByText("Could not save the removal: disk full")).toBeInTheDocument();
    expect(callsTo(spy, "remove_agent_install")).toHaveLength(0);
  });

  it("ends on Add when the agent is removed while its install still runs", async () => {
    let rejectInstall: (reason: string) => void = () => {};
    const spy = spyOnBackend((cmd, args) =>
      cmd === "install_agent"
        ? new Promise((_, reject) => (rejectInstall = reject))
        : withGemini(cmd, args),
    );
    await openAgentsTab();
    await act(async () => {
      fireEvent.click(within(row("Gemini CLI")).getByRole("button", { name: "Add" }));
    });
    await waitFor(() => expect(callsTo(spy, "install_agent")).toHaveLength(1));

    await removeFromRow("Gemini CLI");
    await waitFor(() => expect(callsTo(spy, "remove_agent_install")).toHaveLength(1));
    await act(async () => rejectInstall("INSTALL_CANCELLED"));

    expect(within(row("Gemini CLI")).getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(within(row("Gemini CLI")).queryByRole("progressbar")).toBeNull();
    expect(within(row("Gemini CLI")).queryByText(/Starting the install/)).toBeNull();
  });
});

describe("Catalog actions — Remove in the app", () => {
  it("stops the agent's running sessions first and says so in the question", async () => {
    fakeStore().state.settings.defaultAgentId = "qwen-code";
    const spy = spyOnBackend();
    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    await act(async () => {
      fireEvent.change(prompt, { target: { value: "get started" } });
      fireEvent.keyDown(prompt, { key: "Enter" });
    });
    await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(1));
    const sessionId = String(callsTo(spy, "acp_start_session")[0][1]?.sessionId);

    fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Agents/ }));
    const qwen = await screen.findByRole("listitem", { name: "Qwen Code" });
    fireEvent.click(within(qwen).getByRole("button", { name: "Remove" }));
    expect(within(qwen).getByText(/Its open sessions stop\./)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(qwen).getByRole("button", { name: "Remove" }));
    });

    await waitFor(() => expect(callsTo(spy, "acp_stop_session")).toEqual([["acp_stop_session", { sessionId }]]));
    await waitFor(() => expect(callsTo(spy, "remove_agent_install")).toHaveLength(1));
  });
});
