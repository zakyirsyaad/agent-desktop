import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import { Onboarding } from "../components/Onboarding";
import type { AgentProfile } from "../types";
import { fakeProfiles, makeProfile } from "./fixtures/agents";
import { fakeCatalog } from "./fixtures/catalog";
import { AgentCatalog } from "../components/agents/AgentCatalog";

const claudeCode: AgentProfile = makeProfile({
  id: "claude-acp",
  source: "registry",
  distribution: "npx",
  name: "Claude Code",
  command: "claude",
  detected: true,
  detected_path: "/opt/homebrew/bin/claude",
  models: ["claude-sonnet-5-5"],
});

const omp: AgentProfile = makeProfile({
  id: "omp",
  name: "Oh-My-Pi",
  command: "omp",
  detected: false,
  models: [],
});

const aider: AgentProfile = makeProfile({
  id: "aider",
  name: "Aider",
  command: "aider",
  detected: true,
  detected_path: "/usr/local/bin/aider",
  models: ["gpt-5"],
});

const AGENTS = [claudeCode, omp, aider];

/** Recent folders may carry persistence fields the component must not forward. */
type FolderFixture = { name: string; path: string; lastOpenedAt?: number };

const RECENT_FOLDERS: FolderFixture[] = [
  { name: "trading-bot", path: "/Users/test/trading-bot", lastOpenedAt: 1_699_000_000_000 },
  { name: "docs-site", path: "/Users/test/docs-site", lastOpenedAt: 1_698_000_000_000 },
];

const SUGGESTED_FOLDERS: FolderFixture[] = [{ name: "my-app", path: "/Users/test/my-app" }];

type OnboardingResult = { defaultAgentId: string; folder: { name: string; path: string } };

type OnboardingProps = {
  agents: AgentProfile[];
  settings?: { enabledAgents?: string[] };
  recentFolders: FolderFixture[];
  suggestedFolders: FolderFixture[];
  agentsPanel: ReactNode;
  onPickFolder: () => Promise<{ name: string; path: string } | null>;
  onComplete: (result: OnboardingResult) => void;
};

function notDetected(agent: AgentProfile): AgentProfile {
  return { ...agent, detected: false, detected_path: null };
}

function renderOnboarding(overrides: Partial<OnboardingProps> = {}): OnboardingProps {
  const props: OnboardingProps = {
    agents: AGENTS,
    recentFolders: RECENT_FOLDERS,
    suggestedFolders: SUGGESTED_FOLDERS,
    agentsPanel: <p>The agent catalog</p>,
    onPickFolder: vi.fn(async () => null),
    onComplete: vi.fn(),
    ...overrides,
  };
  render(<Onboarding {...props} />);
  return props;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

async function clickButton(name: string): Promise<void> {
  await click(screen.getByRole("button", { name }));
}

function stepItems(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Setup progress" })).getAllByRole("listitem");
}

function folderButton(listLabel: string, namePattern: RegExp): HTMLElement {
  return within(screen.getByRole("list", { name: listLabel })).getByRole("button", {
    name: namePattern,
  });
}

async function selectRecentFolder(namePattern: RegExp = /trading-bot/): Promise<void> {
  await click(folderButton("Recent folders", namePattern));
}

async function goToFolderStep(): Promise<void> {
  await clickButton("Continue");
}

async function goToDefaultAgentStep(): Promise<void> {
  await goToFolderStep();
  await selectRecentFolder();
  await clickButton("Continue");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Onboarding — agent step", () => {
  it("shows the three setup steps with the agents step marked current", () => {
    renderOnboarding();

    const items = stepItems();

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Agents",
      "Folder",
      "Default agent",
    ]);
    expect(items[0]).toHaveAttribute("aria-current", "step");
    expect(items[1]).not.toHaveAttribute("aria-current");
    expect(items[2]).not.toHaveAttribute("aria-current");
    expect(
      screen.getByRole("heading", { level: 2, name: "Check your agents" })
    ).toBeInTheDocument();
  });

  it("counts only the agents in use toward Continue", () => {
    const gemini = makeProfile({ id: "gemini", name: "Gemini CLI", source: "registry", detected: true });
    renderOnboarding({
      agents: [notDetected(claudeCode), gemini],
      settings: { enabledAgents: ["claude-acp"] },
    });

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("blocks Continue and says why when no agent is installed", () => {
    renderOnboarding({
      agents: [notDetected(claudeCode), omp, notDetected(aider)],
    });

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(
      screen.getByText("Install at least one agent to continue.")
    ).toBeInTheDocument();
  });

  it("lets you continue and start with an agent Zorvo can install", async () => {
    const installable = makeProfile({
      ...notDetected(claudeCode),
      availability: "needs_runtime",
      distribution: "npx",
      install_plan: [
        { kind: "node", name: "Node.js", version: "24.11.1", download_bytes: null },
        { kind: "agent", name: "Claude Code", version: "0.9.0", download_bytes: null },
      ],
    });
    const onComplete = vi.fn();
    renderOnboarding({ agents: [installable, omp, notDetected(aider)], onComplete });

    expect(screen.queryByText("Install at least one agent to continue.")).toBeNull();
    await goToDefaultAgentStep();
    const group = screen.getByRole("radiogroup", { name: "Default agent" });
    expect(within(group).getByRole("radio", { name: /Claude Code/ })).toBeChecked();
    await clickButton("Start");

    expect(onComplete).toHaveBeenCalledWith({
      defaultAgentId: "claude-acp",
      folder: { name: "trading-bot", path: "/Users/test/trading-bot" },
    });
  });

  it("enables Continue once at least one agent is ready", () => {
    renderOnboarding();

    expect(screen.queryByText("Install at least one agent to continue.")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("shows the agent panel it is given instead of copy-paste install commands", () => {
    renderOnboarding({ agentsPanel: <input type="search" aria-label="Search agents" /> });

    expect(screen.getByRole("searchbox", { name: "Search agents" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Copy install command/ })).toBeNull();
    expect(screen.queryByRole("list", { name: "Agents" })).toBeNull();
  });

  it("shows the agent catalog, with search and Add", () => {
    const actions = { addAgent: vi.fn(), updateAgent: vi.fn(), removeAgent: vi.fn(), runningSessionCount: () => 0 };
    renderOnboarding({
      agentsPanel: (
        <AgentCatalog
          catalog={{ lastChecked: null, agents: fakeCatalog }}
          error={null}
          agents={fakeProfiles}
          enabledIds={["claude-acp"]}
          actions={actions}
          onCheckAgain={() => Promise.resolve()}
          onRetryLoad={() => {}}
        />
      ),
    });

    expect(screen.getByRole("searchbox", { name: "Search agents" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Copy install command/ })).toBeNull();
  });
});

describe("Onboarding — folder step", () => {
  it("selects the folder returned by the native dialog", async () => {
    const onPickFolder = vi.fn(async () => ({
      name: "picked-app",
      path: "/Users/test/picked-app",
    }));
    renderOnboarding({ onPickFolder });
    await goToFolderStep();

    await clickButton("Open folder…");

    expect(onPickFolder).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(/\/Users\/test\/picked-app/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("keeps Continue disabled when the folder dialog is cancelled", async () => {
    const onPickFolder = vi.fn(async () => null);
    renderOnboarding({ onPickFolder });
    await goToFolderStep();

    await clickButton("Open folder…");

    expect(onPickFolder).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("explains when the folder dialog fails to open", async () => {
    const onPickFolder = vi.fn().mockRejectedValue(new Error("dialog unavailable"));
    renderOnboarding({ onPickFolder });
    await goToFolderStep();

    await clickButton("Open folder…");

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't open the folder dialog.");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("selects a recent folder and enables Continue", async () => {
    renderOnboarding();
    await goToFolderStep();

    const tradingBot = folderButton("Recent folders", /trading-bot/);
    expect(tradingBot).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    await click(tradingBot);

    expect(tradingBot).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("selects a suggested folder and enables Continue", async () => {
    renderOnboarding();
    await goToFolderStep();

    const myApp = folderButton("Suggested folders", /my-app/);
    expect(myApp).toHaveAttribute("aria-pressed", "false");

    await click(myApp);

    expect(myApp).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("returns to the agents step when Back is clicked", async () => {
    renderOnboarding();
    await goToFolderStep();
    expect(
      screen.getByRole("heading", { level: 2, name: "Choose a project folder" })
    ).toBeInTheDocument();

    await clickButton("Back");

    expect(
      screen.getByRole("heading", { level: 2, name: "Check your agents" })
    ).toBeInTheDocument();
    expect(stepItems()[0]).toHaveAttribute("aria-current", "step");
  });
});

function manyFolders(count: number, prefix: string): FolderFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-${index + 1}`,
    path: `/Users/test/developer/${prefix}-${index + 1}`,
  }));
}

describe("Onboarding — long folder lists", () => {
  it("puts a suggested list with more than five folders in a scroll area", async () => {
    renderOnboarding({ suggestedFolders: manyFolders(12, "project") });
    await goToFolderStep();

    const list = screen.getByRole("list", { name: "Suggested folders" });

    expect(within(list).getAllByRole("listitem")).toHaveLength(12);
    expect(list).toHaveClass("overflow-y-auto");
    expect(list.className).toMatch(/max-h-/);
  });

  it("puts a recent list with more than five folders in a scroll area", async () => {
    renderOnboarding({ recentFolders: manyFolders(6, "recent") });
    await goToFolderStep();

    expect(screen.getByRole("list", { name: "Recent folders" })).toHaveClass("overflow-y-auto");
  });

  it("renders a list of five or fewer folders without a scroll area", async () => {
    renderOnboarding({ suggestedFolders: manyFolders(5, "project") });
    await goToFolderStep();

    const suggested = screen.getByRole("list", { name: "Suggested folders" });
    const recent = screen.getByRole("list", { name: "Recent folders" });

    expect(within(suggested).getAllByRole("listitem")).toHaveLength(5);
    expect(suggested).not.toHaveClass("overflow-y-auto");
    expect(suggested.className).not.toMatch(/max-h-/);
    expect(recent).not.toHaveClass("overflow-y-auto");
  });

  it("keeps folders inside the scroll area selectable", async () => {
    renderOnboarding({ suggestedFolders: manyFolders(12, "project") });
    await goToFolderStep();

    const last = folderButton("Suggested folders", /project-12/);
    await click(last);

    expect(last).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});

describe("Onboarding — default agent step", () => {
  it("offers only ready agents and preselects the first one", async () => {
    renderOnboarding();

    await goToDefaultAgentStep();

    expect(
      screen.getByRole("heading", { level: 2, name: "Pick a default agent" })
    ).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "Default agent" });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(within(group).getByRole("radio", { name: /Claude Code/ })).toBeChecked();
    expect(within(group).getByRole("radio", { name: /Aider/ })).not.toBeChecked();
    expect(within(group).queryByRole("radio", { name: /Oh-My-Pi/ })).toBeNull();
    expect(stepItems()[2]).toHaveAttribute("aria-current", "step");
  });

  it("reports the chosen agent and the selected folder when Start is clicked", async () => {
    const onComplete = vi.fn();
    const recentWithTimestamp: FolderFixture = {
      name: "trading-bot",
      path: "/Users/test/trading-bot",
      lastOpenedAt: 1_699_000_000_000,
    };
    renderOnboarding({
      recentFolders: [recentWithTimestamp],
      suggestedFolders: [],
      onComplete,
    });
    await goToFolderStep();
    await selectRecentFolder();
    await clickButton("Continue");

    const group = screen.getByRole("radiogroup", { name: "Default agent" });
    await click(within(group).getByRole("radio", { name: /Aider/ }));
    await clickButton("Start");

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      defaultAgentId: "aider",
      folder: { name: "trading-bot", path: "/Users/test/trading-bot" },
    });
  });

  it("returns to the folder step when Back is clicked", async () => {
    renderOnboarding();
    await goToDefaultAgentStep();

    await clickButton("Back");

    expect(
      screen.getByRole("heading", { level: 2, name: "Choose a project folder" })
    ).toBeInTheDocument();
    expect(stepItems()[1]).toHaveAttribute("aria-current", "step");
  });
});
