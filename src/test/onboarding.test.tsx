import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, act, waitFor } from "@testing-library/react";
import { Onboarding } from "../components/Onboarding";
import { AgentsStep } from "../components/onboarding/AgentsStep";
import type { AgentProfile } from "../types";
import { makeProfile } from "./fixtures/agents";

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

const AIDER_INSTALL_COMMAND = "python -m pip install aider-install && aider-install";

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
  onRecheckAgents: () => void | Promise<void>;
  onPickFolder: () => Promise<{ name: string; path: string } | null>;
  onComplete: (result: OnboardingResult) => void;
};

function notDetected(agent: AgentProfile): AgentProfile {
  return { ...agent, detected: false, detected_path: null };
}

let clipboardWriteText: ReturnType<typeof vi.fn>;

/** jsdom ships no navigator.clipboard, so each test gets a fresh stub. */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

function renderOnboarding(overrides: Partial<OnboardingProps> = {}): OnboardingProps {
  const props: OnboardingProps = {
    agents: AGENTS,
    recentFolders: RECENT_FOLDERS,
    suggestedFolders: SUGGESTED_FOLDERS,
    onRecheckAgents: vi.fn(),
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

function agentItem(agentName: string): HTMLElement {
  const item = within(screen.getByRole("list", { name: "Agents" }))
    .getAllByRole("listitem")
    .find((candidate) => candidate.textContent?.includes(agentName));
  if (!item) {
    throw new Error(`No agent list item for "${agentName}"`);
  }
  return item;
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
  clipboardWriteText = stubClipboard();
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

  it("lists every agent with its readiness status and detected path", () => {
    renderOnboarding();

    const items = within(screen.getByRole("list", { name: "Agents" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);

    const claude = agentItem("Claude Code");
    expect(claude).toHaveTextContent("Ready");
    expect(claude).toHaveTextContent("/opt/homebrew/bin/claude");

    const aider = agentItem("Aider");
    expect(aider).toHaveTextContent("Ready");
    expect(aider).toHaveTextContent("/usr/local/bin/aider");

    expect(screen.queryByText("Oh-My-Pi")).toBeNull();
  });

  it("lists only the agents in use", () => {
    const gemini = makeProfile({ id: "gemini", name: "Gemini CLI", source: "registry", detected: true });
    renderOnboarding({
      agents: [claudeCode, gemini],
      settings: { enabledAgents: ["claude-acp"] },
    });

    expect(agentItem("Claude Code")).toBeInTheDocument();
    expect(screen.queryByText("Gemini CLI")).toBeNull();
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

  it("enables Continue once at least one agent is ready", () => {
    renderOnboarding();

    expect(screen.queryByText("Install at least one agent to continue.")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("offers a copyable install command for a missing terminal agent", async () => {
    // Onboarding lists only agents in use, so render the step itself with a missing one.
    render(<AgentsStep agents={[claudeCode, notDetected(aider)]} onRecheckAgents={vi.fn()} />);

    const item = agentItem("Aider");
    expect(item).toHaveTextContent("Not installed");
    const command = within(item).getByText(AIDER_INSTALL_COMMAND);
    expect(command.closest("code")).not.toBeNull();

    await click(within(item).getByRole("button", {
      name: "Copy install command for Aider",
    }));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(AIDER_INSTALL_COMMAND);
    });
    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
  });

  it("points a missing registry agent at Node.js", () => {
    renderOnboarding({ agents: [notDetected(claudeCode), omp, aider] });

    const item = agentItem("Claude Code");
    expect(item).toHaveTextContent("Not installed");
    expect(item).toHaveTextContent(/Node\.js 22/);
    expect(within(item).queryByRole("button", { name: /Copy install command/ })).toBeNull();
  });

  it("re-runs agent detection when Check again is clicked", async () => {
    const onRecheckAgents = vi.fn().mockResolvedValue(undefined);
    renderOnboarding({ onRecheckAgents });

    await clickButton("Check again");

    expect(onRecheckAgents).toHaveBeenCalledTimes(1);
  });

  it("explains when re-running agent detection fails", async () => {
    const onRecheckAgents = vi.fn().mockRejectedValue(new Error("detection failed"));
    renderOnboarding({ onRecheckAgents });

    await clickButton("Check again");

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't check your agents.");
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
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
